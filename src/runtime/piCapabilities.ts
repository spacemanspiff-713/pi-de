import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeHealth } from "../protocol";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 512 * 1024;

export interface PiCapabilities {
  rpc: boolean;
  session: boolean;
  approve: boolean;
  extensions: boolean;
}

export async function probePiRuntime(executable: string): Promise<RuntimeHealth> {
  try {
    const [versionResult, helpResult] = await Promise.all([
      execFileAsync(executable, ["--version"], { timeout: 8_000, maxBuffer: MAX_OUTPUT, encoding: "utf8" }),
      execFileAsync(executable, ["--help"], { timeout: 8_000, maxBuffer: MAX_OUTPUT, encoding: "utf8" }),
    ]);
    const version = firstNonemptyLine(versionResult.stdout) || "unknown";
    const capabilities = detectCapabilities(helpResult.stdout);
    if (!capabilities.rpc) {
      return {
        status: "incompatible",
        executable,
        version,
        capabilities,
        message: `Pi ${version} does not advertise RPC mode. Update Pi before using this extension.`,
      };
    }
    return {
      status: "ready",
      executable,
      version,
      capabilities,
      message: `Pi ${version} is ready.`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const missing = isMissingExecutable(error);
    return {
      status: missing ? "missing" : "error",
      executable,
      message: missing
        ? `Pi was not found at “${executable}”. Install Pi or configure pi.executablePath.`
        : `Pi could not be inspected: ${detail}`,
    };
  }
}

export function detectCapabilities(help: string): PiCapabilities {
  return {
    rpc: /--mode\s+<mode>[\s\S]*\brpc\b/i.test(help) || /--mode[\s\S]{0,200}(text|json)[\s\S]{0,200}rpc/i.test(help),
    session: /--session\s+<[^>]+>/i.test(help),
    approve: /--approve\b/i.test(help),
    extensions: /--extension(?:,\s*-e)?\s+<[^>]+>/i.test(help) || /--extension\b/i.test(help),
  };
}

function firstNonemptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function isMissingExecutable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES";
}
