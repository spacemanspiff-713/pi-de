import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

export interface ExecutableResolutionOptions {
  configured?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

export async function resolvePiExecutable(options: ExecutableResolutionOptions = {}): Promise<string> {
  const configured = options.configured?.trim() || "pi";
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];

  if (configured !== "pi" || isAbsolute(configured) || configured.includes("/") || configured.includes("\\")) {
    const explicit = await firstExecutable(expandCandidates(configured, extensions), platform);
    return explicit ?? configured;
  }

  const pathCandidates = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => expandCandidates(join(directory, "pi"), extensions));
  const commonCandidates = [
    join(home, ".npm-global", "bin", "pi"),
    join(home, ".local", "bin", "pi"),
    join(home, ".bun", "bin", "pi"),
    join(home, ".volta", "bin", "pi"),
    "/usr/local/bin/pi",
    "/usr/bin/pi",
  ].flatMap((candidate) => expandCandidates(candidate, extensions));

  return (await firstExecutable([...pathCandidates, ...commonCandidates], platform)) ?? configured;
}

export function likelyExecutableExists(executable: string): boolean {
  if (!isAbsolute(executable) && !executable.includes("/") && !executable.includes("\\")) return true;
  return existsSync(executable);
}

async function firstExecutable(candidates: string[], platform: NodeJS.Platform): Promise<string | undefined> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      // Continue searching.
    }
  }
  return undefined;
}

function expandCandidates(candidate: string, extensions: string[]): string[] {
  if (/\.[a-z0-9]+$/i.test(candidate)) return [candidate];
  return extensions.map((extension) => `${candidate}${extension}`);
}
