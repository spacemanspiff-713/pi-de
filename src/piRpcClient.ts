import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { JsonlDecoder } from "./jsonl";

export type RpcRecord = Record<string, unknown> & { type?: string };

interface PendingRequest {
  resolve: (record: RpcRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PiRpcStartOptions {
  executable: string;
  cwd: string;
  args?: string[];
  sessionFile?: string;
  approveWorkspace?: boolean;
}

export class PiRpcClient {
  private child?: ChildProcessWithoutNullStreams;
  private decoder = new JsonlDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events = new EventEmitter();
  private expectedStop = false;

  constructor(private readonly log: (line: string) => void) {}

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  onRecord(listener: (record: RpcRecord) => void): () => void {
    this.events.on("record", listener);
    return () => this.events.off("record", listener);
  }

  onExit(listener: (details: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  start(options: PiRpcStartOptions): void {
    if (this.running) return;

    const args = [...(options.args ?? []), "--mode", "rpc"];
    if (options.approveWorkspace) args.push("--approve");
    if (options.sessionFile) args.push("--session", options.sessionFile);

    this.expectedStop = false;
    this.decoder = new JsonlDecoder();
    this.log(`Starting: ${options.executable} ${args.map(quoteArg).join(" ")}`);
    this.log(`Working directory: ${options.cwd}`);

    const child = spawn(options.executable, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of this.decoder.push(chunk)) this.handleLine(line);
    });

    child.stdout.on("end", () => {
      for (const line of this.decoder.end()) this.handleLine(line);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) this.log(`[pi stderr] ${line}`);
      }
    });

    child.on("error", (error) => {
      this.log(`Pi process error: ${error.message}`);
      this.rejectAll(error);
      this.events.emit("record", { type: "client_error", error: error.message });
    });

    child.on("close", (code, signal) => {
      const expected = this.expectedStop;
      this.log(`Pi exited (code=${String(code)}, signal=${String(signal)}, expected=${expected})`);
      this.child = undefined;
      this.rejectAll(new Error(`Pi RPC process exited with code ${String(code)}`));
      this.events.emit("exit", { code, signal, expected });
    });
  }

  async request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcRecord> {
    if (!this.running || !this.child) throw new Error("Pi RPC process is not running");
    const id = typeof command.id === "string" ? command.id : randomUUID();
    const payload = { ...command, id };

    return await new Promise<RpcRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC request timed out: ${String(command.type ?? "unknown")}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(payload);
    });
  }

  send(record: Record<string, unknown>): void {
    if (!this.running) return;
    this.write(record);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.expectedStop = true;
    if (this.running) this.send({ type: "abort" });

    await new Promise<void>((resolve) => {
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_500);
      child.once("close", () => {
        clearTimeout(forceTimer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private write(record: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw new Error("Pi RPC stdin is unavailable");
    stdin.write(`${JSON.stringify(record)}\n`);
  }

  private handleLine(line: string): void {
    let record: RpcRecord;
    try {
      record = JSON.parse(line) as RpcRecord;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Invalid JSON from Pi: ${message}`);
      this.events.emit("record", { type: "client_error", error: `Invalid JSON from Pi: ${message}` });
      return;
    }

    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.pending.get(record.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(record.id);
        if (record.success === false) {
          pending.reject(new Error(String(record.error ?? `Pi command ${String(record.command)} failed`)));
        } else {
          pending.resolve(record);
        }
        return;
      }
    }

    this.events.emit("record", record);
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function quoteArg(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}
