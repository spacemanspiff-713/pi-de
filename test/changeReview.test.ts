import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitChangeReview, mergeDiffStats } from "../src/changeReview";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("GitChangeReview", () => {
  it("parses rename and line statistics", () => {
    expect(mergeDiffStats("2\t1\tnew.ts\n", "R100\told.ts\tnew.ts\n")).toEqual([
      { path: "new.ts", previousPath: "old.ts", status: "R100", additions: 2, deletions: 1 },
    ]);
  });

  it("checkpoints dirty work, detects task changes, and reverts one file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pide-change-test-"));
    cleanups.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.com");
    await writeFile(join(root, "app.txt"), "committed\n");
    git(root, "add", "app.txt");
    git(root, "commit", "-m", "initial");

    await writeFile(join(root, "app.txt"), "pre-task dirty\n");
    const review = new GitChangeReview(() => undefined);
    await review.begin(root, "change files");

    await writeFile(join(root, "app.txt"), "agent change\nextra\n");
    await writeFile(join(root, "new.txt"), "new file\n");
    const changeSet = await review.finish();

    expect(changeSet?.files.map((file) => file.path)).toEqual(["app.txt", "new.txt"]);
    expect(changeSet?.additions).toBeGreaterThan(0);
    await review.revert("app.txt");
    expect(await readFile(join(root, "app.txt"), "utf8")).toBe("pre-task dirty\n");
    expect(review.changeSet?.files.map((file) => file.path)).toEqual(["new.txt"]);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
