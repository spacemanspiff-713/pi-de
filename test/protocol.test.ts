import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWebviewMessage } from "../src/protocol";
import { resolvePiExecutable } from "../src/runtime/piExecutable";

describe("typed webview protocol", () => {
  it("accepts known bounded messages and rejects malformed input", () => {
    expect(parseWebviewMessage({ type: "prompt", text: "hello" })).toEqual({ type: "prompt", text: "hello" });
    expect(parseWebviewMessage({ type: "contextSearch", query: "src", requestId: "1" })).toEqual({
      type: "contextSearch",
      query: "src",
      requestId: "1",
    });
    expect(parseWebviewMessage({ type: "prompt", text: 42 })).toBeUndefined();
    expect(parseWebviewMessage({ type: "prompt", text: "x".repeat(2 * 1024 * 1024 + 1) })).toBeUndefined();
    expect(parseWebviewMessage({ type: "deleteEverything" })).toBeUndefined();
    expect(parseWebviewMessage(null)).toBeUndefined();
  });
});

describe("Pi executable discovery", () => {
  it("finds Pi on PATH before falling back to the configured command", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-executable-"));
    const executable = join(root, "pi");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    await expect(resolvePiExecutable({
      configured: "pi",
      env: { PATH: [root, "/not-present"].join(delimiter) },
      home: join(root, "home"),
      platform: process.platform,
    })).resolves.toBe(executable);
  });
});
