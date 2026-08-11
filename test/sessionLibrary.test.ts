import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSessions, parseSession } from "../src/sessionLibrary";

const cleanups: string[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("session library", () => {
  it("extracts names, previews, usage, model, and tool counts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-session-test-"));
    cleanups.push(root);
    const file = join(root, "session.jsonl");
    await writeFile(file, [
      JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00Z", cwd: "/project" }),
      JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "user", content: "Build the feature" } }),
      JSON.stringify({ type: "message", id: "b", parentId: "a", message: { role: "assistant", provider: "openai", model: "gpt-test", content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }], usage: { totalTokens: 150, cost: { total: 0.02 } } } }),
      JSON.stringify({ type: "session_info", id: "c", parentId: "b", name: "Feature work" }),
    ].join("\n"));

    const session = await parseSession(file);
    expect(session).toMatchObject({
      id: "session-1",
      name: "Feature work",
      preview: "Build the feature",
      messageCount: 2,
      toolCalls: 1,
      tokens: 150,
      cost: 0.02,
      model: "openai/gpt-test",
    });
  });

  it("discovers only sessions for the requested cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-session-discovery-"));
    cleanups.push(root);
    const project = join(root, "project");
    const agent = join(root, "agent");
    const sessions = join(agent, "sessions", "--project--");
    await mkdir(project, { recursive: true });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "one.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "one", timestamp: "2026-01-01T00:00:00Z", cwd: project })}\n`);
    await writeFile(join(sessions, "other.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "other", timestamp: "2026-01-01T00:00:00Z", cwd: join(root, "other") })}\n`);

    const found = await discoverSessions({ cwd: project, agentDir: agent });
    expect(found.map((session) => session.id)).toEqual(["one"]);
  });
});
