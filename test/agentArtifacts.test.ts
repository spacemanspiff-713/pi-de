import { describe, expect, it } from "vitest";
import { extractAgentSources, previewText, sourceSummary } from "../src/agentArtifacts";

describe("agent artifact sources", () => {
  it("prefers tool fetch metadata over markdown mentions and tags official docs", () => {
    const sources = extractAgentSources({
      result: "See [Webview guide](https://code.visualstudio.com/api/extension-guides/webview) and https://reddit.com/r/vscode",
      toolEvents: [
        {
          tool: "web_fetch",
          status: "done",
          args: { url: "https://code.visualstudio.com/api/extension-guides/webview", query: "webview ux" },
          result: "Use --vscode-* theme colors.",
        },
        {
          tool: "web_fetch",
          status: "failed",
          isError: true,
          args: { url: "https://example.com/missing" },
          result: "HTTP 404",
        },
      ],
    });

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "https://code.visualstudio.com/api/extension-guides/webview",
        kind: "official",
        status: "ok",
        tool: "web_fetch",
      }),
      expect.objectContaining({
        url: "https://example.com/missing",
        kind: "secondary",
        status: "failed",
        note: "HTTP 404",
      }),
      expect.objectContaining({
        url: "https://reddit.com/r/vscode",
        kind: "community",
        status: "mentioned",
      }),
    ]));
    expect(sourceSummary(sources)).toContain("1 official");
    expect(sourceSummary(sources)).toContain("1 failed");
    expect(previewText("  one   two three  ", 7)).toBe("one tw…");
  });
});
