import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

const shell = `<!doctype html><html><body>
  <section id="session-tabs"></section>
  <span id="status-dot"></span><button id="model"></button><button id="thinking"></button><span id="session-stats"></span>
  <nav id="board-nav"><button data-board="chat"></button><button data-board="swarm"></button><button data-board-action="changes"></button><button data-board-action="mcp"></button></nav><section id="swarm-strip"></section>
  <div id="banner"></div>
  <section id="runtime-health"><strong id="runtime-health-title"></strong><p id="runtime-health-message"></p><div id="runtime-health-details"></div><button id="runtime-trust"></button><button id="runtime-settings"></button><button id="runtime-retry"></button></section>
  <div id="widget"></div><section id="extension-request"></section><div id="change-summary"></div><section id="chat-board"><main id="transcript"></main></section>
  <div id="jump" class="hidden"><button>Jump</button></div>
  <section id="changes-panel"><button data-close-panel="changes-panel"></button><div id="changes-totals"></div><div id="changes-list"></div></section>
  <section id="agent-lab-panel"><button data-close-panel="agent-lab-panel"></button><div id="agent-lab-summary"></div><textarea id="agent-lab-task"></textarea><div id="agent-lab-roles"></div><button id="agent-lab-run"></button><button id="agent-lab-stop"></button><button id="agent-lab-refresh"></button><div id="agent-lab-runs"></div><aside id="artifact-inspector" class="hidden"><strong id="inspector-title"></strong><span id="inspector-meta"></span><button id="inspector-close"></button><nav id="inspector-tabs"></nav><div id="inspector-body"></div></aside></section>
  <section id="mcp-panel"><button data-close-panel="mcp-panel"></button><div id="mcp-totals"></div><div id="mcp-list"></div><div id="mcp-prompts"></div></section>
  <div id="dispatch-bar"><select id="dispatch-mode"></select><input id="dispatch-include-pi" type="checkbox" checked><div id="dispatch-roles"></div><div id="dispatch-shortcuts"></div></div>
  <div id="context-chips"></div><textarea id="prompt"></textarea>
  <button id="sessions"></button><button id="resources"></button><button id="agent-lab"></button><button id="compact"></button><button id="reload-session"></button><button id="changes"></button><button id="mcp"></button><button id="new"></button><button id="restart"></button><button id="output"></button>
  <span id="dispatch-summary"></span>
  <button id="mcp-reconnect-all"></button><button id="mcp-config"></button>
  <button id="attach"></button><button id="stop"></button><button id="send"></button>
  <span id="queue"></span><div id="command-menu"></div><div id="context-menu"></div>
</body></html>`;

describe("bundled Pi webview", () => {
  it("renders sanitized rich Markdown and code actions", async () => {
    const dom = new JSDOM(shell, {
      runScripts: "outside-only",
      pretendToBeVisual: true,
      url: "https://vscode-webview.test/",
    });
    const posted: Array<Record<string, unknown>> = [];
    const window = dom.window as any;
    window.acquireVsCodeApi = () => ({
      postMessage: (message: Record<string, unknown>) => posted.push(message),
      getState: () => ({}),
      setState: () => undefined,
    });
    window.HTMLElement.prototype.scrollTo = () => undefined;

    const bundle = readFileSync(join(process.cwd(), "media", "main.js"), "utf8");
    window.eval(bundle);
    expect(posted.some((message) => message.type === "ready")).toBe(true);

    window.dispatchEvent(new window.MessageEvent("message", {
      data: {
        type: "runtimeHealth",
        health: { status: "missing", executable: "/missing/pi", message: "Pi was not found." },
      },
    }));
    expect(window.document.querySelector("#runtime-health-title")?.textContent).toContain("not installed");
    expect(window.document.querySelector("#runtime-health-details")?.textContent).toContain("/missing/pi");

    window.dispatchEvent(new window.MessageEvent("message", {
      data: { type: "runtimeHealth", health: { status: "untrusted", message: "Trust is required." } },
    }));
    const trustButton = window.document.querySelector("#runtime-trust");
    expect(trustButton?.classList.contains("hidden")).toBe(false);
    trustButton?.click();
    expect(posted.some((message) => message.type === "manageTrust")).toBe(true);

    window.dispatchEvent(new window.MessageEvent("message", {
      data: {
        type: "history",
        messages: [{
          role: "assistant",
          text: "## Result\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst answer = 42;\n```\n\n[Docs](https://example.com)",
        }],
      },
    }));

    const document = window.document;
    expect(document.querySelector("h2")?.textContent).toBe("Result");
    expect(document.querySelectorAll("table td")).toHaveLength(2);
    expect(document.querySelector("code")?.textContent).toContain("const answer = 42;");
    expect(document.querySelector("code .hljs-keyword")?.textContent).toBe("const");
    expect(document.querySelectorAll("button[data-code-action]")).toHaveLength(2);

    document.querySelector('button[data-code-action="copy"]')?.click();
    expect(posted.some((message) => message.type === "copyText" && String(message.text).includes("answer = 42"))).toBe(true);

    document.querySelector("a")?.click();
    expect(posted.some((message) => message.type === "openLink" && message.href === "https://example.com")).toBe(true);

    window.dispatchEvent(new window.MessageEvent("message", {
      data: {
        type: "changeSet",
        changeSet: {
          id: "task-1",
          checkpoint: "abcdef123456",
          additions: 4,
          deletions: 2,
          files: [{ path: "src/app.ts", status: "M", additions: 4, deletions: 2 }],
        },
      },
    }));
    expect(document.querySelector("#change-summary")?.textContent).toContain("1 file");
    expect(document.querySelector("#changes-list")?.textContent).toContain("src/app.ts");

    window.dispatchEvent(new window.MessageEvent("message", {
      data: {
        type: "mcpStatus",
        snapshot: {
          connectedCount: 1,
          totalTools: 5,
          totalResources: 2,
          servers: [{ name: "docs", status: "connected", toolCount: 5, resourceCount: 2, disabled: false }],
        },
      },
    }));
    expect(document.querySelector("#mcp-totals")?.textContent).toContain("1/1 connected");
    expect(document.querySelector("#mcp-list")?.textContent).toContain("docs");

    window.dispatchEvent(new window.MessageEvent("message", {
      data: { type: "sessionTabs", tabs: [{ id: "a", title: "A", status: "idle", active: true }, { id: "b", title: "B", status: "working", unread: true }] },
    }));
    expect(document.querySelector("#session-tabs")?.textContent).toContain("B");

    window.dispatchEvent(new window.MessageEvent("message", {
      data: { type: "agentLab", maxConcurrent: 4, roles: [{ id: "architect", name: "Architect", source: "builtin", description: "Plans", model: "openrouter/deepseek/deepseek-v4-pro", tools: ["read"], maxToolCalls: 8 }], runs: [{ id: "run-1", roleName: "Architect", roleId: "architect", task: "Plan a safe change", status: "running", progress: "Reading architecture", result: "See [Docs](https://code.visualstudio.com/api/extension-guides/webview)", model: "openrouter/deepseek/deepseek-v4-pro", toolCallCount: 2, maxToolCalls: 8, lastTool: "web_fetch", toolCounts: { web_fetch: 1, read: 1 }, toolEvents: [{ tool: "web_fetch", status: "done", args: { url: "https://code.visualstudio.com/api/extension-guides/webview" } }], sources: [{ url: "https://code.visualstudio.com/api/extension-guides/webview", title: "Webview guide", status: "ok", kind: "official" }] }] },
    }));
    expect(document.querySelector("#agent-lab-summary")?.textContent).toContain("1 roles");
    expect(document.querySelector("#agent-lab-runs")?.textContent).toContain("See [Docs]");
    expect(document.querySelector("#agent-lab-roles")?.textContent).toContain("openrouter/deepseek");
    expect(document.querySelector("#agent-lab-runs")?.textContent).toContain("2/8");
    expect(document.querySelector("#agent-lab-runs")?.textContent).toContain("Plan a safe change");
    expect(document.querySelector("#swarm-strip")?.textContent).toContain("Architect");
    (document.querySelector("[data-board=swarm]") as HTMLButtonElement | null)?.click();
    expect(document.querySelector("#agent-lab-panel")?.classList.contains("hidden")).toBe(false);
    (document.querySelector("[data-agent-inspect]") as HTMLButtonElement | null)?.click();
    expect(document.querySelector("#artifact-inspector")?.classList.contains("hidden")).toBe(false);
    expect(document.querySelector("#inspector-title")?.textContent).toBe("Architect");
    expect(document.querySelector("#inspector-body")?.textContent).toContain("Docs");
    (document.querySelector("#inspector-tabs button:nth-child(2)") as HTMLButtonElement | null)?.click();
    expect(document.querySelector("#inspector-body")?.textContent).toContain("code.visualstudio.com");
    expect(document.querySelector("#dispatch-mode")?.querySelectorAll("option").length).toBeGreaterThan(1);
    expect(document.querySelector("#dispatch-roles")?.textContent).toContain("Architect");
    (document.querySelector("#dispatch-mode") as HTMLSelectElement).value = "plan";
    document.querySelector("#dispatch-mode")?.dispatchEvent(new window.Event("change", { bubbles: true }));
    (document.querySelector("#prompt") as HTMLTextAreaElement).value = "Plan a safe change";
    (document.querySelector("#send") as HTMLButtonElement).click();
    expect(posted.some((message) => message.type === "dispatch" && message.mode === "plan" && Array.isArray(message.roleIds) && message.roleIds.includes("architect"))).toBe(true);

    window.dispatchEvent(new window.MessageEvent("message", {
      data: { type: "sessionStats", stats: { cost: 0.1234, contextUsage: { tokens: 60_000, contextWindow: 200_000, percent: 30 } } },
    }));
    expect(document.querySelector("#session-stats")?.textContent).toContain("30%");
    (document.querySelector("#compact") as HTMLButtonElement | null)?.click();
    expect(posted.some((message) => message.type === "compactSession")).toBe(true);
    (document.querySelector("#resources") as HTMLButtonElement | null)?.click();
    expect(posted.some((message) => message.type === "openResources")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.window.close();
  });
});
