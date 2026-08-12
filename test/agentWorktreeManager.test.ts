import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentAfterContent, agentBeforeContent, applyAgentPatch, captureAgentChanges, createAgentPatch, createAgentWorktree, removeAgentWorktree } from "../src/controllers/agentWorktreeManager";

const git = (cwd: string, args: string[]) => new Promise<void>((resolve, reject) => execFile("git", ["-C", cwd, ...args], (error, _stdout, stderr) => error ? reject(new Error(stderr)) : resolve()));

describe("AgentWorktreeManager", () => {
  it("isolates coding changes in a branch worktree and applies only a selected patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pide-agent-worktree-root-"));
    const storage = await mkdtemp(join(tmpdir(), "pide-agent-worktree-storage-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "hello.txt"), "before\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);

    const worktree = await createAgentWorktree({ repository: root, storageRoot: storage, id: "1234567890abcdef", role: "Implementer" });
    await writeFile(join(worktree.path, "hello.txt"), "after\n");
    await writeFile(join(worktree.path, "new.txt"), "new\n");

    expect(await agentBeforeContent(worktree, "hello.txt")).toBe("before\n");
    expect(await agentAfterContent(worktree, "hello.txt")).toBe("after\n");
    expect((await captureAgentChanges(worktree)).map((file) => file.path)).toEqual(["hello.txt", "new.txt"]);
    expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("before\n");

    await applyAgentPatch(root, await createAgentPatch(worktree, ["hello.txt"]));
    expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("after\n");
    await expect(readFile(join(root, "new.txt"), "utf8")).rejects.toThrow();

    await removeAgentWorktree(worktree, true);
  });
});
