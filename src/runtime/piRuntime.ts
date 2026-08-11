import { EventEmitter } from "node:events";
import type { RuntimeHealth } from "../protocol";
import { PiRpcClient, type PiRpcStartOptions, type RpcRecord } from "../piRpcClient";
import { probePiRuntime } from "./piCapabilities";
import { resolvePiExecutable } from "./piExecutable";

export type PiRuntimeEvent =
  | { type: "health"; health: RuntimeHealth }
  | { type: "record"; record: RpcRecord }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null; expected: boolean };

export interface PiRuntimeStartOptions extends Omit<PiRpcStartOptions, "executable"> {
  configuredExecutable?: string;
}

export class PiRuntime {
  private readonly events = new EventEmitter();
  private rpc?: PiRpcClient;
  private unsubscribeRecord?: () => void;
  private unsubscribeExit?: () => void;
  private currentHealth?: RuntimeHealth;

  constructor(private readonly log: (line: string) => void) {}

  get client(): PiRpcClient | undefined {
    return this.rpc;
  }

  get running(): boolean {
    return this.rpc?.running ?? false;
  }

  get health(): RuntimeHealth | undefined {
    return this.currentHealth;
  }

  onEvent(listener: (event: PiRuntimeEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  publishHealth(health: RuntimeHealth): void {
    this.currentHealth = health;
    this.events.emit("event", { type: "health", health } satisfies PiRuntimeEvent);
  }

  async start(options: PiRuntimeStartOptions): Promise<boolean> {
    if (this.running) return true;
    const executable = await resolvePiExecutable({ configured: options.configuredExecutable });
    this.publishHealth({ status: "checking", executable, message: "Checking the Pi runtime…" });
    const health = await probePiRuntime(executable);
    this.publishHealth(health);
    if (health.status !== "ready") return false;

    const rpc = new PiRpcClient(this.log);
    this.rpc = rpc;
    this.unsubscribeRecord = rpc.onRecord((record) => {
      this.events.emit("event", { type: "record", record } satisfies PiRuntimeEvent);
    });
    this.unsubscribeExit = rpc.onExit(({ code, signal, expected }) => {
      this.events.emit("event", { type: "exit", code, signal, expected } satisfies PiRuntimeEvent);
    });
    rpc.start({
      executable,
      cwd: options.cwd,
      args: options.args,
      sessionFile: options.sessionFile,
      approveWorkspace: options.approveWorkspace,
    });
    return true;
  }

  async stop(): Promise<void> {
    this.unsubscribeRecord?.();
    this.unsubscribeRecord = undefined;
    this.unsubscribeExit?.();
    this.unsubscribeExit = undefined;
    const rpc = this.rpc;
    this.rpc = undefined;
    if (rpc) await rpc.stop();
  }
}
