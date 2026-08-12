import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import MarkdownIt from "markdown-it";
import type {
  ContextCompletionItem,
  HostToWebviewMessage,
  McpStatusSnapshot,
  PiCommandInfo,
  AgentRole,
  AgentRunSnapshot,
  WebviewToHostMessage,
} from "../src/protocol";
import type { ChangeSet } from "../src/changeReview";
import { renderRuntimeHealth } from "./runtimeHealth";

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): { draft?: string } | undefined;
  setState(state: { draft?: string }): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(code, language) {
    if (language && hljs.getLanguage(language)) {
      try { return hljs.highlight(code, { language, ignoreIllegals: true }).value; }
      catch { /* Fall back to escaped code. */ }
    }
    return markdown.utils.escapeHtml(code);
  },
});

markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/)[0] || "code";
  const highlighted = markdown.options.highlight(token.content, language, "");
  const safeLanguage = markdown.utils.escapeHtml(language);
  return `<div class="code-block">
    <div class="code-toolbar"><span>${safeLanguage}</span><button data-code-action="copy">Copy</button><button data-code-action="insert">Insert</button></div>
    <pre><code class="hljs language-${safeLanguage}">${highlighted}</code></pre>
  </div>`;
};

(() => {
  const vscode = acquireVsCodeApi();
  const transcript = document.getElementById("transcript");
  const prompt = document.getElementById("prompt") as HTMLTextAreaElement;
  const banner = document.getElementById("banner");
  const statusDot = document.getElementById("status-dot");
  const sessionTabs = document.getElementById("session-tabs");
  const modelButton = document.getElementById("model");
  const thinkingButton = document.getElementById("thinking");
  const sessionStats = document.getElementById("session-stats");
  const compactButton = document.getElementById("compact") as HTMLButtonElement;
  const reloadSessionButton = document.getElementById("reload-session") as HTMLButtonElement;
  const sendButton = document.getElementById("send") as HTMLButtonElement;
  const stopButton = document.getElementById("stop") as HTMLButtonElement;
  const attachButton = document.getElementById("attach") as HTMLButtonElement;
  const contextChips = document.getElementById("context-chips");
  const commandMenu = document.getElementById("command-menu");
  const contextMenu = document.getElementById("context-menu");
  const queue = document.getElementById("queue");
  const widget = document.getElementById("widget");
  const extensionRequest = document.getElementById("extension-request");
  const jump = document.getElementById("jump");
  const changesButton = document.getElementById("changes");
  const changeSummary = document.getElementById("change-summary");
  const changesPanel = document.getElementById("changes-panel");
  const changesTotals = document.getElementById("changes-totals");
  const changesList = document.getElementById("changes-list");
  const agentLabPanel = document.getElementById("agent-lab-panel");
  const agentLabSummary = document.getElementById("agent-lab-summary");
  const agentLabTask = document.getElementById("agent-lab-task") as HTMLTextAreaElement;
  const agentLabRoles = document.getElementById("agent-lab-roles");
  const agentLabRuns = document.getElementById("agent-lab-runs");
  const mcpPanel = document.getElementById("mcp-panel");
  const mcpTotals = document.getElementById("mcp-totals");
  const mcpList = document.getElementById("mcp-list");
  const mcpPrompts = document.getElementById("mcp-prompts");
  const runtimeHealth = document.getElementById("runtime-health");
  const runtimeHealthTitle = document.getElementById("runtime-health-title");
  const runtimeHealthMessage = document.getElementById("runtime-health-message");
  const runtimeHealthDetails = document.getElementById("runtime-health-details");
  const runtimeTrustButton = document.getElementById("runtime-trust") as HTMLButtonElement;

  interface ToolElements {
    details: HTMLDetailsElement;
    icon: HTMLElement;
    state: HTMLElement;
    output: HTMLElement;
  }

  let activeAssistant: HTMLElement | undefined;
  let activeThinking: HTMLElement | undefined;
  let commands: PiCommandInfo[] = [];
  let latestContextRequest = "";
  let contextSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let latestChangeSet: ChangeSet | undefined;
  let latestMcpStatus: McpStatusSnapshot | undefined;
  let latestAgentRoles: AgentRole[] = [];
  let latestAgentRuns: AgentRunSnapshot[] = [];
  let latestMcpPrompts: PiCommandInfo[] = [];
  let renderFrame: number | undefined;
  const tools = new Map<string, ToolElements>();
  const messageSource = new WeakMap<HTMLElement, string>();
  const pendingRenders = new Set<HTMLElement>();
  const persisted = vscode.getState() || {};
  if (typeof persisted.draft === "string") prompt.value = persisted.draft;

  document.getElementById("sessions").addEventListener("click", () => vscode.postMessage({ type: "openSession" }));
  document.getElementById("resources").addEventListener("click", () => vscode.postMessage({ type: "openResources" }));
  document.getElementById("agent-lab").addEventListener("click", () => vscode.postMessage({ type: "openAgentLab" }));
  compactButton.addEventListener("click", () => vscode.postMessage({ type: "compactSession" }));
  reloadSessionButton.addEventListener("click", () => vscode.postMessage({ type: "reloadSession" }));
  document.getElementById("new").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
  document.getElementById("restart").addEventListener("click", () => vscode.postMessage({ type: "restart" }));
  document.getElementById("output").addEventListener("click", () => vscode.postMessage({ type: "showOutput" }));
  changesButton.addEventListener("click", () => {
    if (latestChangeSet?.files?.length) showPanel(changesPanel);
    else vscode.postMessage({ type: "reviewChanges" });
  });
  document.getElementById("mcp").addEventListener("click", () => showPanel(mcpPanel));
  document.getElementById("agent-lab-run").addEventListener("click", () => runAgentLab());
  document.getElementById("agent-lab-stop").addEventListener("click", () => vscode.postMessage({ type: "stopAgentLab" }));
  document.getElementById("agent-lab-refresh").addEventListener("click", () => vscode.postMessage({ type: "refreshAgentLab" }));
  document.getElementById("mcp-reconnect-all").addEventListener("click", () => vscode.postMessage({ type: "mcpAction", action: "reconnect" }));
  document.getElementById("mcp-config").addEventListener("click", () => vscode.postMessage({ type: "openMcpConfig" }));
  runtimeTrustButton.addEventListener("click", () => vscode.postMessage({ type: "manageTrust" }));
  document.getElementById("runtime-settings").addEventListener("click", () => vscode.postMessage({ type: "openRuntimeSettings" }));
  document.getElementById("runtime-retry").addEventListener("click", () => vscode.postMessage({ type: "retryRuntime" }));
  document.querySelectorAll<HTMLElement>("[data-close-panel]").forEach((button) => button.addEventListener("click", () => {
    document.getElementById(button.dataset.closePanel ?? "")?.classList.add("hidden");
  }));
  modelButton.addEventListener("click", () => vscode.postMessage({ type: "pickModel" }));
  thinkingButton.addEventListener("click", () => vscode.postMessage({ type: "pickThinking" }));
  stopButton.addEventListener("click", () => vscode.postMessage({ type: "abort" }));
  sendButton.addEventListener("click", send);
  attachButton.addEventListener("click", () => insertAtCursor("@"));
  jump.querySelector("button").addEventListener("click", () => scrollToBottom(true));

  prompt.addEventListener("input", () => {
    vscode.setState({ ...persisted, draft: prompt.value });
    updateCommandMenu();
    updateContextSearch();
    updateContextChips();
  });
  prompt.addEventListener("click", updateContextSearch);
  prompt.addEventListener("keyup", updateContextSearch);
  prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === "Tab") {
      const first = !contextMenu.classList.contains("hidden")
        ? contextMenu.querySelector("button")
        : !commandMenu.classList.contains("hidden") ? commandMenu.querySelector("button") : undefined;
      if (first) {
        event.preventDefault();
        first.click();
      }
    }
    if (event.key === "Escape") {
      commandMenu.classList.add("hidden");
      contextMenu.classList.add("hidden");
    }
  });
  transcript.addEventListener("scroll", () => jump.classList.toggle("hidden", isNearBottom()));
  transcript.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const link = target?.closest("a");
    if (link) {
      event.preventDefault();
      vscode.postMessage({ type: "openLink", href: link.getAttribute("href") || "" });
      return;
    }
    const action = target?.closest<HTMLButtonElement>("button[data-code-action]");
    if (!action) return;
    const code = action.closest(".code-block")?.querySelector("code")?.textContent || "";
    if (!code) return;
    if (action.dataset.codeAction === "copy") {
      vscode.postMessage({ type: "copyText", text: code });
      action.textContent = "Copied";
      setTimeout(() => { action.textContent = "Copy"; }, 1_200);
    } else if (action.dataset.codeAction === "insert") {
      vscode.postMessage({ type: "insertText", text: code });
      action.textContent = "Inserted";
      setTimeout(() => { action.textContent = "Insert"; }, 1_200);
    }
  });

  window.addEventListener("message", ({ data }: MessageEvent<HostToWebviewMessage>) => {
    switch (data.type) {
      case "connection": setConnection(data.status, data.message); break;
      case "runtimeHealth":
        renderRuntimeHealth({
          container: runtimeHealth,
          title: runtimeHealthTitle,
          message: runtimeHealthMessage,
          details: runtimeHealthDetails,
          trustButton: runtimeTrustButton,
        }, data.health);
        break;
      case "history": renderHistory(data.messages || []); break;
      case "commands": commands = data.commands || []; updateCommandMenu(); break;
      case "contextResults":
        if (data.requestId === latestContextRequest) renderContextMenu(data.items || []);
        break;
      case "state": updateState(data); break;
      case "extensionUiRequest": renderExtensionRequest(data); break;
      case "sessionStats": renderSessionStats(data.stats); break;
      case "sessionTabs": renderSessionTabs(data.tabs || []); break;
      case "agentLab": renderAgentLab(data.roles || [], data.runs || [], data.maxConcurrent || 4); showPanel(agentLabPanel); break;
      case "clear":
        transcript.textContent = "";
        tools.clear();
        activeAssistant = undefined;
        activeThinking = undefined;
        emptyState();
        break;
      case "userPrompt": removeEmptyState(); appendMessage("user", data.text); break;
      case "textDelta": appendAssistantDelta(data.delta || ""); break;
      case "thinkingDelta": ensureThinking(); activeThinking.append(document.createTextNode(data.delta || "")); scrollToBottom(); break;
      case "messageEnd":
        if (data.role === "assistant") { activeAssistant = undefined; activeThinking = undefined; }
        break;
      case "toolStart": appendTool(data); break;
      case "toolUpdate": updateTool(data.id, data.result, false, false); break;
      case "toolEnd": updateTool(data.id, data.result, true, data.isError); break;
      case "busy": setBusy(Boolean(data.value)); break;
      case "notice": appendNotice(data.message, "notice"); break;
      case "error": appendNotice(data.message, "error"); break;
      case "extensionStatus": if (data.text) banner.textContent = String(data.text); break;
      case "widget":
        widget.textContent = Array.isArray(data.lines) ? data.lines.join("\n") : "";
        widget.classList.toggle("hidden", !widget.textContent);
        break;
      case "prefill":
        prompt.value = String(data.text || "");
        updateContextChips();
        prompt.focus();
        break;
      case "changeSet":
        latestChangeSet = data.changeSet;
        renderChangeSet();
        break;
      case "showChanges":
        latestChangeSet = data.changeSet;
        renderChangeSet();
        showPanel(changesPanel);
        break;
      case "hideChanges":
        latestChangeSet = undefined;
        renderChangeSet();
        changesPanel.classList.add("hidden");
        break;
      case "mcpStatus":
        latestMcpStatus = data.snapshot;
        renderMcp();
        break;
      case "mcpPrompts":
        latestMcpPrompts = data.prompts || [];
        renderMcp();
        break;
      case "queue": {
        const count = arrayLength(data.steering) + arrayLength(data.followUp);
        queue.textContent = count ? `${count} queued` : "";
        break;
      }
    }
  });

  function send() {
    const text = prompt.value.trim();
    if (!text) return;
    vscode.postMessage({ type: "prompt", text });
    prompt.value = "";
    vscode.setState({ ...persisted, draft: "" });
    commandMenu.classList.add("hidden");
    contextMenu.classList.add("hidden");
    updateContextChips();
    prompt.focus();
  }

  function insertAtCursor(text) {
    const start = prompt.selectionStart;
    const end = prompt.selectionEnd;
    prompt.setRangeText(text, start, end, "end");
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    prompt.focus();
  }

  function setConnection(status, message) {
    statusDot.className = `status-dot ${status || ""}`;
    banner.textContent = message || "";
    banner.classList.toggle("hidden", status === "ready");
  }

  function runAgentLab() {
    const roleIds = Array.from(agentLabRoles.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")).map((input) => input.value);
    vscode.postMessage({ type: "runAgentLab", roleIds, task: agentLabTask.value });
  }

  function renderAgentLab(roles: AgentRole[], runs: AgentRunSnapshot[], maxConcurrent: number) {
    latestAgentRoles = roles;
    latestAgentRuns = runs;
    agentLabSummary.textContent = `${roles.length} roles · ${runs.filter((run) => ["queued", "starting", "running"].includes(run.status)).length}/${maxConcurrent} active or queued · read-only MVP`;
    agentLabRoles.textContent = "";
    for (const role of roles) {
      const label = document.createElement("label");
      label.className = "agent-role";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = role.id;
      input.checked = ["architect", "explorer", "reviewer"].includes(role.id);
      const body = document.createElement("span");
      body.innerHTML = `<strong>${escapeHtml(role.name)}</strong><small>${escapeHtml(role.source)} · ${escapeHtml(role.description || "")}</small>`;
      label.append(input, body);
      agentLabRoles.append(label);
    }
    agentLabRuns.textContent = "";
    for (const run of runs) {
      const item = document.createElement("article");
      item.className = `agent-run ${run.status}`;
      const resultHtml = run.result ? DOMPurify.sanitize(markdown.render(run.result)) : "";
      item.innerHTML = `<header><strong>${escapeHtml(run.roleName)}</strong><span>${escapeHtml(run.status)}</span></header>
        <div class="agent-progress">${escapeHtml(run.progress || "")}${run.durationMs ? ` · ${Math.round(run.durationMs / 1000)}s` : ""}</div>
        ${run.error ? `<div class="agent-error">${escapeHtml(run.error)}</div>` : ""}
        ${run.toolEvents?.length ? `<div class="agent-tools">${run.toolEvents.slice(-8).map((tool) => escapeHtml(tool.tool)).join(" · ")}</div>` : ""}
        ${resultHtml ? `<details ${run.status === "succeeded" ? "open" : ""}><summary>Result</summary><div class="markdown">${resultHtml}</div></details>` : ""}
        <div class="agent-actions"><button data-agent-stop="${escapeHtml(run.id)}">Stop</button><button data-agent-retry="${escapeHtml(run.id)}">Retry</button></div>`;
      item.querySelector("[data-agent-stop]")?.addEventListener("click", () => vscode.postMessage({ type: "stopAgentLab", runId: run.id }));
      item.querySelector("[data-agent-retry]")?.addEventListener("click", () => vscode.postMessage({ type: "retryAgentLab", runId: run.id }));
      agentLabRuns.append(item);
    }
  }

  function renderSessionTabs(tabs) {
    sessionTabs.textContent = "";
    sessionTabs.classList.toggle("hidden", tabs.length <= 1);
    for (const tab of tabs) {
      const button = document.createElement("button");
      button.className = `session-tab ${tab.active ? "active" : ""} ${tab.unread ? "unread" : ""}`;
      button.textContent = `${tab.status === "working" ? "● " : ""}${tab.title || "Session"}`;
      button.title = `${tab.status}${tab.unread ? " · unread" : ""}`;
      button.addEventListener("click", () => vscode.postMessage({ type: "activateTab", id: tab.id }));
      const close = document.createElement("span");
      close.textContent = " ×";
      close.addEventListener("click", (event) => { event.stopPropagation(); vscode.postMessage({ type: "closeTab", id: tab.id }); });
      button.append(close);
      sessionTabs.append(button);
    }
  }

  function updateState(state) {
    const model = state.model || {};
    modelButton.textContent = model.name || model.id || "Select model";
    modelButton.title = model.provider && model.id ? `${model.provider}/${model.id}` : "Select Pi model";
    thinkingButton.textContent = `thinking: ${state.thinkingLevel || "off"}`;
    const maintenance = state.isCompacting ? "Compacting…" : state.isRetrying ? "Retrying…" : "";
    compactButton.disabled = Boolean(state.isStreaming || state.isCompacting);
    reloadSessionButton.disabled = Boolean(state.isStreaming || state.isCompacting);
    compactButton.title = maintenance || "Compact session context";
    reloadSessionButton.title = maintenance || "Reload session context";
    setBusy(Boolean(state.isStreaming));
  }

  function renderSessionStats(stats) {
    const usage = stats?.contextUsage || {};
    const percent = typeof usage.percent === "number" ? `${Math.round(usage.percent)}%` : "—";
    const tokens = typeof usage.tokens === "number" ? formatCount(usage.tokens) : "unknown";
    const windowSize = typeof usage.contextWindow === "number" ? formatCount(usage.contextWindow) : "unknown";
    sessionStats.textContent = `context: ${percent}`;
    sessionStats.title = `Context window: ${tokens} / ${windowSize}${typeof stats?.cost === "number" ? ` · session cost $${stats.cost.toFixed(4)}` : ""}`;
  }

  function formatCount(value) {
    return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value);
  }

  function renderExtensionRequest(request) {
    extensionRequest.textContent = "";
    const title = document.createElement("strong"); title.textContent = request.title; extensionRequest.append(title);
    if (request.message) { const message = document.createElement("p"); message.textContent = request.message; extensionRequest.append(message); }
    const form = document.createElement("div"); form.className = "panel-toolbar";
    const respond = (response) => { vscode.postMessage({ type: "extensionUiResponse", id: request.id, ...response }); extensionRequest.classList.add("hidden"); };
    if (request.method === "select") {
      for (const option of request.options || []) { const button = document.createElement("button"); button.textContent = option; button.addEventListener("click", () => respond({ value: option })); form.append(button); }
    } else if (request.method === "confirm") {
      const yes = document.createElement("button"); yes.textContent = "Confirm"; yes.addEventListener("click", () => respond({ confirmed: true })); form.append(yes);
    } else {
      const input = document.createElement(request.method === "editor" ? "textarea" : "input"); input.value = request.prefill || ""; input.placeholder = request.placeholder || ""; if (request.method === "editor") (input as HTMLTextAreaElement).rows = 5;
      const submit = document.createElement("button"); submit.textContent = "Submit"; submit.addEventListener("click", () => respond({ value: input.value })); form.append(input, submit);
    }
    const cancel = document.createElement("button"); cancel.textContent = "Cancel"; cancel.addEventListener("click", () => respond({ cancelled: true })); form.append(cancel);
    extensionRequest.append(form); extensionRequest.classList.remove("hidden");
  }

  function setBusy(value) {
    stopButton.classList.toggle("hidden", !value);
    sendButton.textContent = value ? "Queue" : "Send";
    document.body.classList.toggle("busy", value);
    statusDot.classList.toggle("working", value);
  }

  function renderHistory(messages) {
    transcript.textContent = "";
    tools.clear();
    activeAssistant = undefined;
    activeThinking = undefined;
    if (!messages.length) { emptyState(); return; }
    for (const message of messages) {
      if (message.role === "toolResult") {
        const id = `history-${tools.size}`;
        appendTool({ id, name: message.toolName || "tool", args: undefined });
        updateTool(id, { content: [{ type: "text", text: message.text || "Tool completed" }] }, true, message.isError);
      } else {
        appendMessage(message.role, message.text || "", message.thinking);
      }
    }
    scrollToBottom(true);
  }

  function emptyState() {
    if (document.getElementById("empty-state")) return;
    const element = document.createElement("section");
    element.id = "empty-state";
    element.className = "empty-state";
    const mark = document.createElement("div");
    mark.className = "pi-mark";
    mark.textContent = "π";
    const title = document.createElement("h2");
    title.textContent = "Build with Pi";
    const copy = document.createElement("p");
    copy.textContent = "Your agent, tools, skills, MCP servers, and memory—inside VS Code.";
    element.append(mark, title, copy);
    transcript.append(element);
  }

  function removeEmptyState() { document.getElementById("empty-state")?.remove(); }

  function appendMessage(role, text, thinking = "") {
    removeEmptyState();
    const article = document.createElement("article");
    article.className = `message ${role}`;
    const label = document.createElement("div");
    label.className = "message-label";
    label.textContent = role === "user" ? "You" : role === "assistant" ? "Pi" : role;
    const body = document.createElement("div");
    body.className = "message-body markdown-body";
    messageSource.set(body, text || "");
    renderMarkdown(body, text || "");
    article.append(label);
    if (thinking) article.append(createThinking(thinking));
    article.append(body);
    transcript.append(article);
    scrollToBottom();
    return body;
  }

  function ensureAssistant() {
    if (!activeAssistant) activeAssistant = appendMessage("assistant", "");
  }

  function appendAssistantDelta(delta) {
    ensureAssistant();
    messageSource.set(activeAssistant, `${messageSource.get(activeAssistant) || ""}${delta}`);
    queueMarkdownRender(activeAssistant);
    scrollToBottom();
  }

  function queueMarkdownRender(element) {
    pendingRenders.add(element);
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      for (const pending of pendingRenders) renderMarkdown(pending, messageSource.get(pending) || "");
      pendingRenders.clear();
      renderFrame = undefined;
    });
  }

  function renderMarkdown(element, source) {
    const rendered = markdown.render(source);
    element.innerHTML = DOMPurify.sanitize(rendered, {
      ADD_ATTR: ["data-code-action", "class"],
      FORBID_TAGS: ["style", "iframe", "object", "embed"],
    });
  }

  function ensureThinking() {
    if (activeThinking) return;
    removeEmptyState();
    let article = transcript.lastElementChild;
    if (!article || !article.classList.contains("assistant")) {
      activeAssistant = appendMessage("assistant", "");
      article = transcript.lastElementChild;
    }
    const details = createThinking("");
    article.insertBefore(details, article.querySelector(".message-body"));
    activeThinking = details.querySelector("pre");
  }

  function createThinking(text) {
    const details = document.createElement("details");
    details.className = "thinking";
    const summary = document.createElement("summary");
    summary.textContent = "Reasoning";
    const content = document.createElement("pre");
    content.textContent = text;
    details.append(summary, content);
    return details;
  }

  function appendTool(data) {
    removeEmptyState();
    const details = document.createElement("details");
    details.className = "tool";
    const summary = document.createElement("summary");
    const icon = document.createElement("span");
    icon.className = "tool-icon running";
    icon.textContent = "◇";
    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = String(data.name || "tool");
    const state = document.createElement("span");
    state.className = "tool-state";
    state.textContent = "running";
    summary.append(icon, name, state);
    const args = document.createElement("pre");
    args.className = "tool-args";
    args.textContent = data.args === undefined ? "" : pretty(data.args);
    const output = document.createElement("pre");
    output.className = "tool-output";
    details.append(summary, args, output);
    transcript.append(details);
    tools.set(String(data.id), { details, icon, state, output });
    scrollToBottom();
  }

  function updateTool(id, result, done, isError) {
    const tool = tools.get(String(id));
    if (!tool) return;
    const text = resultText(result);
    if (text) tool.output.textContent = text;
    if (done) {
      tool.icon.textContent = isError ? "×" : "✓";
      tool.icon.className = `tool-icon ${isError ? "failed" : "done"}`;
      tool.state.textContent = isError ? "failed" : "done";
      if (isError) tool.details.open = true;
    }
    scrollToBottom();
  }

  function resultText(result) {
    if (!result) return "";
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.filter((item) => item && item.type === "text").map((item) => item.text).join("\n");
    return text || (typeof result === "string" ? result : "");
  }

  function appendNotice(message, kind) {
    removeEmptyState();
    const element = document.createElement("div");
    element.className = `inline-notice ${kind}`;
    element.textContent = String(message || "");
    transcript.append(element);
    scrollToBottom();
  }

  function showPanel(panel) {
    document.querySelectorAll(".control-panel").forEach((candidate) => {
      if (candidate !== panel) candidate.classList.add("hidden");
    });
    panel.classList.remove("hidden");
  }

  function renderChangeSet() {
    const files = latestChangeSet?.files || [];
    const pending = files.filter((file) => !file.accepted);
    changesButton.classList.toggle("hidden", !files.length);
    changeSummary.textContent = "";
    changesList.textContent = "";
    if (!files.length) {
      changeSummary.classList.add("hidden");
      changesTotals.textContent = "No file changes in the latest Pi task.";
      return;
    }

    const summaryText = `${pending.length || files.length} file${(pending.length || files.length) === 1 ? "" : "s"}  +${latestChangeSet.additions} −${latestChangeSet.deletions}`;
    const summaryButton = document.createElement("button");
    summaryButton.textContent = pending.length ? `${summaryText} · Review changes` : `${summaryText} · Reviewed`;
    summaryButton.addEventListener("click", () => showPanel(changesPanel));
    changeSummary.append(summaryButton);
    changeSummary.classList.remove("hidden");
    changesTotals.textContent = `${files.length} changed · +${latestChangeSet.additions} −${latestChangeSet.deletions} · checkpoint ${String(latestChangeSet.checkpoint || "").slice(0, 10)}`;

    for (const file of files) {
      const row = document.createElement("div");
      row.className = `panel-row change-row${file.accepted ? " accepted" : ""}`;
      const main = document.createElement("div");
      main.className = "panel-row-main";
      const title = document.createElement("strong");
      title.textContent = file.path;
      const meta = document.createElement("span");
      const stats = file.additions === null ? "binary" : `+${file.additions || 0} −${file.deletions || 0}`;
      meta.textContent = `${file.status} · ${stats}${file.accepted ? " · accepted" : ""}`;
      main.append(title, meta);
      const actions = document.createElement("div");
      actions.className = "row-actions";
      actions.append(panelAction("Diff", () => vscode.postMessage({ type: "openDiff", path: file.path })));
      if (!file.accepted) {
        actions.append(panelAction("Accept", () => vscode.postMessage({ type: "acceptChange", path: file.path })));
        actions.append(panelAction("Revert", () => vscode.postMessage({ type: "revertChange", path: file.path }), "danger"));
      }
      row.append(main, actions);
      changesList.append(row);
    }
  }

  function renderMcp() {
    const snapshot: McpStatusSnapshot = latestMcpStatus ?? { servers: [] };
    const servers = snapshot.servers;
    mcpTotals.textContent = servers.length
      ? `${snapshot.connectedCount || 0}/${servers.length} connected · ${snapshot.totalTools || 0} tools · ${snapshot.totalResources || 0} resources`
      : "No MCP servers reported. Pi may still be initializing the adapter.";
    mcpList.textContent = "";
    for (const server of servers) {
      const row = document.createElement("div");
      row.className = "panel-row";
      const main = document.createElement("div");
      main.className = "panel-row-main";
      const title = document.createElement("strong");
      title.textContent = server.name;
      const meta = document.createElement("span");
      meta.innerHTML = `<i class="server-status ${safeClass(server.status)}"></i>${escapeText(server.status)} · ${Number(server.toolCount || 0)} tools${server.resourceCount === undefined ? "" : ` · ${Number(server.resourceCount)} resources`}`;
      main.append(title, meta);
      const actions = document.createElement("div");
      actions.className = "row-actions";
      if (server.disabled) {
        actions.append(panelAction("Enable", () => vscode.postMessage({ type: "mcpAction", action: "enable", server: server.name })));
      } else {
        actions.append(panelAction(server.status === "connected" ? "Reconnect" : "Connect", () => vscode.postMessage({ type: "mcpAction", action: "reconnect", server: server.name })));
        if (server.status === "needs-auth") actions.append(panelAction("Authenticate", () => vscode.postMessage({ type: "mcpAction", action: "auth", server: server.name })));
        actions.append(panelAction("Disable", () => vscode.postMessage({ type: "mcpAction", action: "disable", server: server.name }), "danger"));
      }
      row.append(main, actions);
      mcpList.append(row);
    }

    mcpPrompts.textContent = "";
    if (!latestMcpPrompts.length) {
      const empty = document.createElement("div");
      empty.className = "panel-empty";
      empty.textContent = "No cached MCP prompts.";
      mcpPrompts.append(empty);
    } else {
      for (const item of latestMcpPrompts) {
        const button = document.createElement("button");
        button.className = "prompt-row";
        button.innerHTML = `<strong>/${escapeText(item.name)}</strong><span>${escapeText(item.description || "MCP prompt")}</span>`;
        button.addEventListener("click", () => {
          vscode.postMessage({ type: "mcpAction", action: "prompt", command: item.name });
          mcpPanel.classList.add("hidden");
        });
        mcpPrompts.append(button);
      }
    }
  }

  function panelAction(label, handler, kind = "") {
    const button = document.createElement("button");
    button.textContent = label;
    if (kind) button.classList.add(kind);
    button.addEventListener("click", handler);
    return button;
  }

  function safeClass(value) {
    return String(value || "unknown").replace(/[^a-z0-9_-]/gi, "");
  }

  function escapeText(value) {
    const element = document.createElement("span");
    element.textContent = String(value || "");
    return element.innerHTML;
  }

  function updateCommandMenu() {
    const before = prompt.value.slice(0, prompt.selectionStart);
    const match = before.match(/^\/([^\s]*)$/);
    if (!match) { commandMenu.classList.add("hidden"); return; }
    contextMenu.classList.add("hidden");
    const query = match[1].toLowerCase();
    const matches = commands.filter((command) => command.name.toLowerCase().includes(query)).slice(0, 8);
    commandMenu.textContent = "";
    for (const command of matches) {
      const button = completionButton(`/${command.name}`, command.description || command.source || "Pi command");
      button.addEventListener("click", () => {
        prompt.value = `/${command.name} `;
        commandMenu.classList.add("hidden");
        prompt.focus();
      });
      commandMenu.append(button);
    }
    commandMenu.classList.toggle("hidden", !matches.length);
  }

  function updateContextSearch() {
    const match = contextMatch();
    if (!match) { contextMenu.classList.add("hidden"); return; }
    commandMenu.classList.add("hidden");
    clearTimeout(contextSearchTimer);
    contextSearchTimer = setTimeout(() => {
      latestContextRequest = `${Date.now()}-${Math.random()}`;
      vscode.postMessage({ type: "contextSearch", query: match.query, requestId: latestContextRequest });
    }, 80);
  }

  function renderContextMenu(items: ContextCompletionItem[]) {
    const match = contextMatch();
    if (!match) { contextMenu.classList.add("hidden"); return; }
    contextMenu.textContent = "";
    for (const item of items) {
      const icon = item.kind === "file" ? "▧" : "@";
      const button = completionButton(`${icon} ${item.label}`, item.description || "Context");
      button.addEventListener("click", () => applyContextCompletion(item));
      contextMenu.append(button);
    }
    contextMenu.classList.toggle("hidden", !items.length);
  }

  function applyContextCompletion(item: ContextCompletionItem) {
    const match = contextMatch();
    if (!match) return;
    const suffix = prompt.value.slice(match.end);
    prompt.value = `${prompt.value.slice(0, match.start)}${item.insertText} ${suffix}`;
    const cursor = match.start + item.insertText.length + 1;
    prompt.setSelectionRange(cursor, cursor);
    contextMenu.classList.add("hidden");
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    prompt.focus();
  }

  function contextMatch() {
    const end = prompt.selectionStart;
    const before = prompt.value.slice(0, end);
    const match = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) return undefined;
    const start = before.lastIndexOf("@");
    return { start, end, query: match[1] || "" };
  }

  function updateContextChips() {
    const mentions = mentionTokens(prompt.value);
    contextChips.textContent = "";
    for (const mention of mentions) {
      const chip = document.createElement("span");
      chip.className = "context-chip";
      chip.append(document.createTextNode(mention.label));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${mention.label}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        prompt.value = `${prompt.value.slice(0, mention.start)}${prompt.value.slice(mention.end)}`.replace(/ {2,}/g, " ");
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
        prompt.focus();
      });
      chip.append(remove);
      contextChips.append(chip);
    }
    contextChips.classList.toggle("hidden", !mentions.length);
  }

  function mentionTokens(value) {
    const matches = [];
    const pattern = /@(?:"([^"]+)"|([^\s]+))/g;
    for (const match of value.matchAll(pattern)) {
      matches.push({
        label: `@${match[1] || match[2]}`,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    return matches;
  }

  function completionButton(label, description) {
    const button = document.createElement("button");
    const name = document.createElement("strong");
    name.textContent = label;
    const detail = document.createElement("span");
    detail.textContent = description;
    button.append(name, detail);
    return button;
  }

  function arrayLength(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
  }

  function pretty(value) {
    try { return JSON.stringify(value, null, 2); }
    catch { return String(value); }
  }

  function isNearBottom() { return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100; }

  function scrollToBottom(force = false) {
    if (force || isNearBottom()) {
      requestAnimationFrame(() => transcript.scrollTo({ top: transcript.scrollHeight, behavior: force ? "auto" : "smooth" }));
      jump.classList.add("hidden");
    } else {
      jump.classList.remove("hidden");
    }
  }

  updateContextChips();
  vscode.postMessage({ type: "ready" });
  function escapeHtml(value: string): string {
    return markdown.utils.escapeHtml(String(value));
  }
})();
