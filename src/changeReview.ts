import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

export interface ChangedFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  accepted?: boolean;
  previousPath?: string;
}

export interface ChangeSet {
  id: string;
  prompt: string;
  root: string;
  checkpoint: string;
  checkpointRef: string;
  startedAt: number;
  finishedAt: number;
  files: ChangedFile[];
  additions: number;
  deletions: number;
}

interface ActiveCheckpoint {
  id: string;
  prompt: string;
  root: string;
  checkpoint: string;
  checkpointRef: string;
  startedAt: number;
}

export class GitChangeReview {
  private active?: ActiveCheckpoint;
  private current?: ChangeSet;

  constructor(private readonly log: (line: string) => void) {}

  get changeSet(): ChangeSet | undefined {
    return this.current;
  }

  restore(changeSet: ChangeSet | undefined): void {
    this.current = changeSet;
  }

  async begin(cwd: string, prompt: string): Promise<ActiveCheckpoint | undefined> {
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true })).stdout.trim();
    if (!root) {
      this.active = undefined;
      return undefined;
    }

    const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const { commit } = await createCheckpoint(root, id);
    const checkpointRef = `refs/pi-vscode/checkpoints/${id}`;
    await git(root, ["update-ref", checkpointRef, commit]);
    await pruneCheckpointRefs(root, 25).catch(() => undefined);
    this.active = { id, prompt, root, checkpoint: commit, checkpointRef, startedAt: Date.now() };
    this.current = undefined;
    this.log(`Created Git checkpoint ${checkpointRef} (${commit.slice(0, 10)})`);
    return this.active;
  }

  async finish(): Promise<ChangeSet | undefined> {
    const active = this.active;
    if (!active) return undefined;
    const { tree } = await snapshotWorkingTree(active.root);
    const [numstat, names] = await Promise.all([
      git(active.root, ["diff", "--numstat", "--find-renames", active.checkpoint, tree]),
      git(active.root, ["diff", "--name-status", "--find-renames", active.checkpoint, tree]),
    ]);
    const files = mergeDiffStats(numstat.stdout, names.stdout);
    this.current = {
      ...active,
      finishedAt: Date.now(),
      files,
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    };
    this.active = undefined;
    return this.current;
  }

  accept(path: string): ChangeSet | undefined {
    if (!this.current) return undefined;
    const file = this.current.files.find((candidate) => candidate.path === path);
    if (file) file.accepted = true;
    return this.current;
  }

  async revert(path: string): Promise<ChangeSet | undefined> {
    const changeSet = this.current;
    if (!changeSet) return undefined;
    assertSafeRelativePath(changeSet.root, path);
    const file = changeSet.files.find((candidate) => candidate.path === path);
    const baselinePath = file?.previousPath ?? path;
    assertSafeRelativePath(changeSet.root, baselinePath);
    const existsInCheckpoint = (await git(
      changeSet.root,
      ["cat-file", "-e", `${changeSet.checkpoint}:${baselinePath}`],
      { allowFailure: true },
    )).code === 0;

    if (existsInCheckpoint) {
      await git(changeSet.root, ["--literal-pathspecs", "restore", "--source", changeSet.checkpoint, "--worktree", "--", baselinePath]);
      if (baselinePath !== path) await rm(resolve(changeSet.root, path), { recursive: true, force: true });
    } else {
      await rm(resolve(changeSet.root, path), { recursive: true, force: true });
    }

    const activeBackup = this.active;
    this.active = {
      id: changeSet.id,
      prompt: changeSet.prompt,
      root: changeSet.root,
      checkpoint: changeSet.checkpoint,
      checkpointRef: changeSet.checkpointRef,
      startedAt: changeSet.startedAt,
    };
    const refreshed = await this.finish();
    this.active = activeBackup;
    return refreshed;
  }

  async beforeContent(path: string): Promise<string> {
    const changeSet = this.current;
    if (!changeSet) return "";
    const result = await git(changeSet.root, ["show", `${changeSet.checkpoint}:${path}`], { allowFailure: true, maxBuffer: 10 * 1024 * 1024 });
    return result.code === 0 ? result.stdout : "";
  }

  async afterContent(path: string): Promise<string> {
    const changeSet = this.current;
    if (!changeSet) return "";
    assertSafeRelativePath(changeSet.root, path);
    const absolute = resolve(changeSet.root, path);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) return "";
      const result = await import("node:fs/promises").then(({ readFile }) => readFile(absolute));
      return result.includes(0) ? "[Binary file]" : result.toString("utf8");
    } catch {
      return "";
    }
  }
}

async function pruneCheckpointRefs(root: string, keep: number): Promise<void> {
  const result = await git(root, ["for-each-ref", "--sort=-refname", "--format=%(refname)", "refs/pi-vscode/checkpoints/"]);
  const refs = result.stdout.split(/\r?\n/).filter(Boolean);
  await Promise.all(refs.slice(keep).map((ref) => git(root, ["update-ref", "-d", ref])));
}

async function createCheckpoint(root: string, id: string): Promise<{ tree: string; commit: string }> {
  const { tree } = await snapshotWorkingTree(root);
  const head = (await git(root, ["rev-parse", "--verify", "HEAD"], { allowFailure: true })).stdout.trim();
  const args = ["commit-tree", tree, "-m", `Pi VS Code checkpoint ${id}`];
  if (head) args.push("-p", head);
  const env = {
    GIT_AUTHOR_NAME: "Pi VS Code",
    GIT_AUTHOR_EMAIL: "pi-vscode@local",
    GIT_COMMITTER_NAME: "Pi VS Code",
    GIT_COMMITTER_EMAIL: "pi-vscode@local",
  };
  const commit = (await git(root, args, { env })).stdout.trim();
  if (!commit) throw new Error("Git did not create a checkpoint commit");
  return { tree, commit };
}

async function snapshotWorkingTree(root: string): Promise<{ tree: string }> {
  const temp = await mkdtemp(resolve(tmpdir(), "pi-vscode-index-"));
  const index = resolve(temp, "index");
  try {
    const actualIndex = (await git(root, ["rev-parse", "--git-path", "index"])).stdout.trim();
    try {
      await copyFile(isAbsolute(actualIndex) ? actualIndex : resolve(root, actualIndex), index);
    } catch {
      const head = (await git(root, ["rev-parse", "--verify", "HEAD"], { allowFailure: true })).stdout.trim();
      if (head) await git(root, ["read-tree", "HEAD"], { env: { GIT_INDEX_FILE: index } });
    }
    await git(root, ["add", "-A", "--", "."], { env: { GIT_INDEX_FILE: index }, maxBuffer: 10 * 1024 * 1024 });
    const tree = (await git(root, ["write-tree"], { env: { GIT_INDEX_FILE: index } })).stdout.trim();
    if (!tree) throw new Error("Git did not produce a checkpoint tree");
    return { tree };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export function mergeDiffStats(numstat: string, names: string): ChangedFile[] {
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const line of numstat.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const path = parts.at(-1) ?? "";
    stats.set(path, {
      additions: parts[0] === "-" ? null : Number(parts[0]),
      deletions: parts[1] === "-" ? null : Number(parts[1]),
    });
  }

  const files: ChangedFile[] = [];
  for (const line of names.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "M";
    const path = parts.at(-1) ?? "";
    const previousPath = /^[RC]/.test(status) && parts.length >= 3 ? parts[1] : undefined;
    files.push({
      path,
      status,
      ...(stats.get(path) ?? { additions: 0, deletions: 0 }),
      ...(previousPath ? { previousPath } : {}),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function assertSafeRelativePath(root: string, path: string): void {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Unsafe changed-file path: ${path}`);
  }
}

interface GitOptions {
  allowFailure?: boolean;
  env?: Record<string, string>;
  maxBuffer?: number;
}

function git(cwd: string, args: string[], options: GitOptions = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        cwd,
        env: { ...process.env, ...options.env },
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = typeof (error as NodeJS.ErrnoException & { code?: number } | null)?.code === "number"
          ? Number((error as unknown as { code: number }).code)
          : error ? 1 : 0;
        if (error && !options.allowFailure) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolvePromise({ stdout, stderr, code });
      },
    );
  });
}
