import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { mergeDiffStats, type ChangedFile } from "../changeReview";

export interface AgentWorktree {
  id: string;
  root: string;
  path: string;
  branch: string;
  baseCommit: string;
  baselineStatus: string;
  createdAt: number;
  lifecycle: "active" | "complete" | "integrated" | "abandoned" | "cleaned";
}

export async function createAgentWorktree(input: { repository: string; storageRoot: string; id: string; role: string }): Promise<AgentWorktree> {
  const root = (await git(input.repository, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (!root) throw new Error("Agent coding requires a Git worktree.");
  const baseCommit = (await git(root, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
  if (!baseCommit) throw new Error("Agent coding requires a repository with an initial commit.");
  const baselineStatus = (await git(root, ["status", "--porcelain=v1"])).stdout.slice(0, 64_000);
  const repoKey = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const id = input.id.slice(0, 16);
  const path = join(input.storageRoot, "worktrees", repoKey, id);
  const branch = `pide/agent/${slug(input.role)}/${id.slice(0, 8)}`;
  await mkdir(join(input.storageRoot, "worktrees", repoKey), { recursive: true });
  await git(root, ["worktree", "add", "--force", "-b", branch, path, baseCommit]);
  return { id: input.id, root, path, branch, baseCommit, baselineStatus, createdAt: Date.now(), lifecycle: "active" };
}

export async function captureAgentChanges(worktree: AgentWorktree): Promise<ChangedFile[]> {
  // Intent-to-add exposes untracked files to diff without staging their content; it is confined to the agent worktree.
  await git(worktree.path, ["add", "-N", "--", "."]);
  const [numstat, names] = await Promise.all([
    git(worktree.path, ["diff", "--numstat", "--find-renames", worktree.baseCommit]),
    git(worktree.path, ["diff", "--name-status", "--find-renames", worktree.baseCommit]),
  ]);
  return mergeDiffStats(numstat.stdout, names.stdout);
}

export async function agentBeforeContent(worktree: AgentWorktree, path: string): Promise<string> {
  assertSafePath(path);
  const result = await git(worktree.path, ["show", `${worktree.baseCommit}:${path}`], true);
  return result.code === 0 ? result.stdout : "";
}

export async function agentAfterContent(worktree: AgentWorktree, path: string): Promise<string> {
  assertSafePath(path);
  try {
    const content = await readFile(resolve(worktree.path, path));
    return content.includes(0) ? "[Binary file]" : content.toString("utf8");
  } catch { return ""; }
}

export async function createAgentPatch(worktree: AgentWorktree, files: string[]): Promise<string> {
  const safe = files.map((path) => { assertSafePath(path); return path; });
  if (!safe.length) return "";
  return (await git(worktree.path, ["diff", "--binary", worktree.baseCommit, "--", ...safe], false, 20 * 1024 * 1024)).stdout;
}

export async function applyAgentPatch(repository: string, patch: string): Promise<void> {
  if (!patch.trim()) throw new Error("No accepted agent changes to apply.");
  await gitWithInput(repository, ["apply", "--check", "--whitespace=nowarn", "-"], patch);
  await gitWithInput(repository, ["apply", "--whitespace=nowarn", "-"], patch);
}

export async function validateAgentWorktree(worktree: AgentWorktree, command: string): Promise<{ ok: boolean; output: string }> {
  if (!command.trim()) return { ok: false, output: "No validation command is configured." };
  return await new Promise((resolvePromise) => {
    const child = spawn(command, { cwd: worktree.path, shell: true, env: process.env, windowsHide: true });
    let output = "";
    const collect = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-128_000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ ok: code === 0, output: output || `Exited with code ${String(code)}` }); });
    child.on("error", (error) => { clearTimeout(timer); resolvePromise({ ok: false, output: error.message }); });
  });
}

export async function commitAgentWorktree(worktree: AgentWorktree): Promise<boolean> {
  const status = (await git(worktree.path, ["status", "--porcelain=v1"])).stdout;
  if (!status.trim()) return false;
  await git(worktree.path, ["add", "-A", "--", "."]);
  await git(worktree.path, ["-c", "user.name=PiDE Agent", "-c", "user.email=pide@local", "commit", "-m", `PiDE Agent ${worktree.id.slice(0, 8)} reviewed changes`]);
  return true;
}

export async function mergeAgentBranch(worktree: AgentWorktree): Promise<void> {
  const status = (await git(worktree.root, ["status", "--porcelain=v1"])).stdout;
  if (status.trim()) throw new Error("Your primary workspace has uncommitted changes. Commit/stash them before merging an agent branch.");
  const preflight = await git(worktree.root, ["merge-tree", "--write-tree", "HEAD", worktree.branch], true);
  if (preflight.code !== 0) throw new Error("Agent branch has merge conflicts with the current workspace. Review or apply a selected patch instead.");
  await git(worktree.root, ["merge", "--no-ff", "--no-edit", worktree.branch]);
}

export async function removeAgentWorktree(worktree: AgentWorktree, deleteBranch = false): Promise<void> {
  await git(worktree.root, ["worktree", "remove", "--force", worktree.path], true);
  await rm(worktree.path, { recursive: true, force: true });
  if (deleteBranch) await git(worktree.root, ["branch", "-D", worktree.branch], true);
}

export async function worktreeExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

function assertSafePath(path: string): void {
  const absolute = resolve("/safe", path);
  const rel = relative("/safe", absolute);
  if (!path || rel === ".." || rel.startsWith(`..${sep}`) || path.includes("\0")) throw new Error(`Unsafe agent file path: ${path}`);
}

function git(cwd: string, args: string[], allowFailure = false, maxBuffer = 4 * 1024 * 1024): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => execFile("git", ["-C", cwd, ...args], { cwd, encoding: "utf8", timeout: 120_000, maxBuffer }, (error, stdout, stderr) => {
    const code = typeof (error as { code?: unknown } | null)?.code === "number" ? Number((error as { code: number }).code) : error ? 1 : 0;
    if (error && !allowFailure) return reject(new Error(stderr.trim() || error.message));
    resolvePromise({ stdout, stderr, code });
  }));
}

function gitWithInput(cwd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { cwd, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(stderr.trim() || `git ${args[0]} failed`)));
    child.stdin.end(input);
  });
}

function slug(value: string): string { return basename(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent"; }
