import { execFile } from "node:child_process";
import { basename } from "node:path";
import * as vscode from "vscode";
import { AgentLabController } from "./controllers/agentLabController";
import { ChangeReviewController } from "./controllers/changeReviewController";
import { ExtensionUiBridge } from "./controllers/extensionUiBridge";
import { McpController } from "./controllers/mcpController";
import { SessionController } from "./controllers/sessionController";
import { ResourceController } from "./controllers/resourceController";
import { VscodeContextController } from "./controllers/vscodeContextController";
import { contextScore, extractMentions, mentionText, truncateContext } from "./contextMentions";
import type { RpcRecord } from "./piRpcClient";
import {
  parseWebviewMessage,
  type HostToWebviewMessage,
  type NormalizedMessage,
  type PiCommandInfo,
  type PiState,
  type SessionStats,
} from "./protocol";
import type { PiRuntime } from "./runtime/piRuntime";
import { PiRuntimeManager, type PiRuntimeManagerEvent } from "./runtime/piRuntimeManager";

interface ContextCompletion {
  label: string;
  description: string;
  insertText: string;
  kind: "context" | "file";
  uri?: vscode.Uri;
}

export class PiViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "pide.chatView";

  private view?: vscode.WebviewView;
  private startPromise?: Promise<void>;
  private state: PiState = {};
  private sessionStats: SessionStats = {};
  private disposed = false;
  private fileContextCache?: { expiresAt: number; items: ContextCompletion[] };
  private availableCommands: PiCommandInfo[] = [];
  private readonly runtimeManager: PiRuntimeManager;
  private readonly agentLab: AgentLabController;
  private readonly changeReview: ChangeReviewController;
  private readonly sessions: SessionController;
  private readonly mcp: McpController;
  private readonly extensionUi: ExtensionUiBridge;
  private readonly resources: ResourceController;
  private readonly unsubscribeRuntime: () => void;

  private get runtime(): PiRuntime {
    return this.runtimeManager.activeRuntime;
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    const folder = () => this.workspaceFolder();
    const post = (message: Record<string, unknown>) => this.post(message as HostToWebviewMessage);
    this.runtimeManager = new PiRuntimeManager((runtimeId, line) => this.output.appendLine(`[${new Date().toISOString()}] [${runtimeId}] ${line}`));
    this.runtimeManager.hydrate(
      context.workspaceState.get<Array<{ id: string; sessionFile?: string; title: string; lastActive: number }>>("pide.runtimeTabs", []),
      context.workspaceState.get<string>("pide.activeRuntimeTab"),
    );
    this.agentLab = new AgentLabController(context, output, folder, post);
    this.changeReview = new ChangeReviewController(context, output, folder);
    this.sessions = new SessionController({
      context,
      output,
      workspaceFolder: folder,
      client: () => this.runtime.client,
      state: () => this.state,
      abort: () => this.abort(),
      refresh: () => this.refresh(),
      refreshState: () => this.refreshState(),
      openSessionTab: (session) => this.openSessionTab(session),
      post,
    });
    this.mcp = new McpController(
      folder,
      () => this.runtime.client,
      () => this.restart(),
      post,
      () => this.refreshCommands(),
    );
    this.extensionUi = new ExtensionUiBridge(() => this.runtime.client, post, this.mcp, new VscodeContextController(), () => Boolean(this.view));
    this.resources = new ResourceController(folder, () => this.runtime.health, () => this.restart(), output);
    this.unsubscribeRuntime = this.runtimeManager.onEvent((event) => void this.handleRuntimeEvent(event));
    void this.agentLab.restore();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleWebviewMessage(message);
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.pide");
    this.view?.show?.(true);
  }

  async newSession(): Promise<void> {
    await this.ensureStarted();
    await this.sessions.newSession();
  }

  async openSession(): Promise<void> {
    await this.ensureStarted();
    await this.sessions.openLibrary();
  }

  async openControlCenter(): Promise<void> {
    await this.resources.open();
  }

  async openAgentLab(): Promise<void> {
    await this.reveal();
    await this.agentLab.open();
  }

  async reviewChanges(): Promise<void> {
    await this.reveal();
    const changeSet = this.changeReview.changeSet;
    if (!changeSet?.files.length) {
      void vscode.window.showInformationMessage("Pi has no unreviewed file changes from the latest task.");
      return;
    }
    this.post({ type: "showChanges", changeSet });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.scheme === "pide-agent-change") {
      const params = new URLSearchParams(uri.query);
      return await this.agentLab.provideWorktreeContent(params.get("runId") ?? "", params.get("path") ?? uri.path.replace(/^\//, ""), params.get("side") === "before" ? "before" : "after");
    }
    return await this.changeReview.provideTextDocumentContent(uri);
  }

  async abort(): Promise<void> {
    if (!this.runtime.client?.running) return;
    await this.runtime.client.request({ type: "abort" }).catch((error) => this.showError(error));
  }

  async restart(): Promise<void> {
    this.post({ type: "connection", status: "restarting", message: "Restarting Pi…" });
    await this.stopClient();
    await this.ensureStarted();
  }

  prefillForSelection(): void {
    const editor = vscode.window.activeTextEditor;
    const file = editor ? vscode.workspace.asRelativePath(editor.document.uri, false) : undefined;
    this.post({
      type: "prefill",
      text: file ? `Help me with @selection from ${file}` : "Help me with @selection",
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribeRuntime();
    await this.agentLab.dispose();
    await this.stopClient();
  }

  private async ensureStarted(): Promise<void> {
    if (this.runtime.running) return;
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.startClient().finally(() => {
      this.startPromise = undefined;
    });
    return await this.startPromise;
  }

  private async startClient(): Promise<void> {
    if (this.disposed) return;
    if (!vscode.workspace.isTrusted) {
      this.runtime.publishHealth({
        status: "untrusted",
        message: "Trust this workspace before Pi can start or load project-local resources.",
      });
      this.post({ type: "connection", status: "untrusted", message: "Trust this workspace to start Pi." });
      return;
    }

    const folder = this.workspaceFolder();
    if (!folder) {
      this.runtime.publishHealth({ status: "no-workspace", message: "Open a folder or workspace to use Pi." });
      this.post({ type: "connection", status: "error", message: "Open a folder or workspace to use Pi." });
      return;
    }

    const config = vscode.workspace.getConfiguration("pide", folder.uri);
    const configuredExecutable = config.get<string>("executablePath", "pi").trim() || "pi";
    const extraArgs = config.get<string[]>("extraArgs", []);
    const approveWorkspace = config.get<boolean>("approveTrustedWorkspace", true);
    const sessionFile = this.runtimeManager.activeTab.sessionFile ?? await this.sessions.restoreSessionFile();
    const bridgePath = vscode.Uri.joinPath(this.context.extensionUri, "pi-bridge", "index.ts").fsPath;

    this.post({ type: "connection", status: "starting", message: "Checking and starting Pi…" });
    this.runtimeManager.ensureTab({ id: this.runtimeManager.activeId, sessionFile, title: sessionFile ? basename(sessionFile).replace(/\.jsonl$/i, "") : "Current session" });
    this.postTabs();
    const started = await this.runtimeManager.startActive({
      configuredExecutable,
      cwd: folder.uri.fsPath,
      args: [...extraArgs, "--extension", bridgePath],
      sessionFile,
      approveWorkspace,
    });
    if (!started) return;
    await this.runtimeManager.suspendIdle(config.get<number>("maxActiveRuntimes", 3));
    this.postTabs();

    try {
      await this.refresh();
      const savedChanges = await this.changeReview.restore();
      if (savedChanges?.files.length) this.post({ type: "changeSet", changeSet: savedChanges });
      this.post({ type: "connection", status: "ready", message: "Pi is ready." });
    } catch (error) {
      this.showError(error);
      this.post({ type: "connection", status: "error", message: `Could not start Pi: ${errorMessage(error)}` });
    }
  }

  private async stopClient(): Promise<void> {
    await this.runtimeManager.stopAll();
  }

  private async handleRuntimeEvent(event: PiRuntimeManagerEvent): Promise<void> {
    if (event.type === "health") this.runtimeManager.setHealth(event.runtimeId, event.health);
    if (event.runtimeId !== this.runtimeManager.activeId) {
      if (event.type === "record" && event.record.type === "agent_start") this.runtimeManager.markWorking(event.runtimeId, true);
      if (event.type === "record" && event.record.type === "agent_settled") this.runtimeManager.markWorking(event.runtimeId, false);
      this.postTabs();
      return;
    }
    if (event.type === "record") {
      await this.handleRpcRecord(event.record);
      return;
    }
    if (event.type === "health") {
      this.postTabs();
      this.post({ type: "runtimeHealth", health: event.health });
      if (["missing", "incompatible", "error"].includes(event.health.status)) {
        this.post({ type: "connection", status: "error", message: event.health.message });
      }
      return;
    }
    const message = event.expected ? "Pi stopped." : "Pi exited unexpectedly. Use Restart Agent to reconnect.";
    this.post({ type: "connection", status: event.expected ? "stopped" : "error", message });
    if (!event.expected) {
      this.post({
        type: "runtimeHealth",
        health: { ...this.runtime.health, status: "error", message },
      });
    }
  }

  private async refresh(): Promise<void> {
    const client = this.runtime.client;
    if (!client?.running) throw new Error("Pi is not running");
    const [stateResponse, messagesResponse, commandsResponse] = await Promise.all([
      client.request({ type: "get_state" }),
      client.request({ type: "get_messages" }),
      client.request({ type: "get_commands" }),
    ]);

    this.state = asRecord(stateResponse.data) as PiState;
    this.runtimeManager.ensureTab({ id: this.runtimeManager.activeId, sessionFile: this.state.sessionFile, title: this.state.sessionName || (this.state.sessionFile ? basename(this.state.sessionFile).replace(/\.jsonl$/i, "") : undefined) });
    this.postTabs();
    await this.sessions.rememberCurrent();

    const messages = asArray(asRecord(messagesResponse.data).messages)
      .map(normalizeMessage)
      .filter((message): message is NormalizedMessage => message !== undefined);
    const commands = asArray(asRecord(commandsResponse.data).commands).map((command) => {
      const item = asRecord(command);
      return {
        name: String(item.name ?? ""),
        description: typeof item.description === "string" ? item.description : undefined,
        source: typeof item.source === "string" ? item.source : undefined,
      };
    });
    this.availableCommands = commands;

    this.post({ type: "history", messages });
    this.post({ type: "commands", commands });
    this.mcp.postPrompts(commands);
    this.mcp.postStatus();
    this.postState();
  }

  private async handleWebviewMessage(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (!message) {
      this.output.appendLine("Ignored an invalid webview message.");
      return;
    }
    switch (message.type) {
      case "ready":
        await this.ensureStarted();
        if (this.runtime.running) {
          await this.refresh().catch((error) => this.showError(error));
          if (this.changeReview.changeSet?.files.length) this.post({ type: "changeSet", changeSet: this.changeReview.changeSet });
          this.post({ type: "connection", status: "ready", message: "Pi is ready." });
        }
        break;
      case "prompt":
        await this.sendPrompt(message.text);
        break;
      case "abort":
        await this.abort();
        break;
      case "newSession":
        await this.newSession().catch((error) => this.showError(error));
        break;
      case "openSession":
        await this.openSession().catch((error) => this.showError(error));
        break;
      case "restart":
        await this.restart().catch((error) => this.showError(error));
        break;
      case "pickModel":
        await this.pickModel();
        break;
      case "pickThinking":
        await this.pickThinking();
        break;
      case "contextSearch":
        await this.searchContexts(message.query, message.requestId);
        break;
      case "copyText":
        await vscode.env.clipboard.writeText(message.text);
        break;
      case "insertText": {
        const editor = vscode.window.activeTextEditor;
        if (editor) await editor.edit((edit) => edit.insert(editor.selection.active, message.text));
        break;
      }
      case "openLink":
        await this.openLink(message.href);
        break;
      case "reviewChanges":
        await this.reviewChanges();
        break;
      case "openDiff":
        await this.changeReview.openDiff(message.path);
        break;
      case "acceptChange": {
        const changeSet = await this.changeReview.accept(message.path);
        if (changeSet) this.post({ type: "changeSet", changeSet });
        break;
      }
      case "revertChange":
        await this.revertChange(message.path);
        break;
      case "mcpAction":
        await this.mcp.action(message.action, message.server ?? "", message.command ?? "");
        break;
      case "openMcpConfig":
        await this.mcp.openConfig();
        break;
      case "showOutput":
        this.output.show(true);
        break;
      case "manageTrust":
        await vscode.commands.executeCommand("workbench.trust.manage");
        break;
      case "openRuntimeSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:spacemanspiff-713.pide");
        break;
      case "retryRuntime":
        await this.restart();
        break;
      case "compactSession":
        await this.compactSession();
        break;
      case "reloadSession":
        await this.reloadSession();
        break;
      case "openResources":
        await this.resources.open();
        break;
      case "openAgentLab":
        await this.agentLab.open();
        break;
      case "refreshAgentLab":
        await this.agentLab.refresh();
        break;
      case "runAgentLab":
        await this.agentLab.run(message.roleIds, message.task);
        break;
      case "stopAgentLab":
        await this.agentLab.stop(message.runId);
        break;
      case "retryAgentLab":
        if (message.runId) await this.agentLab.retry(message.runId);
        break;
      case "reviewAgentWorktree":
        if (message.runId) await this.agentLab.review(message.runId);
        break;
      case "validateAgentWorktree":
        await this.agentLab.validate(message.runId, message.command);
        break;
      case "openAgentDiff":
        await this.agentLab.openDiff(message.runId, message.path);
        break;
      case "applyAgentPatch":
        await this.agentLab.applyAccepted(message.runId, message.paths);
        break;
      case "mergeAgentWorktree":
        if (message.runId) await this.agentLab.merge(message.runId);
        break;
      case "cleanupAgentWorktree":
        if (message.runId) await this.agentLab.cleanupWorktree(message.runId);
        break;
      case "activateTab":
        await this.activateTab(message.id);
        break;
      case "closeTab":
        await this.runtimeManager.close(message.id);
        await this.refresh().catch(() => undefined);
        this.postTabs();
        break;
      case "extensionUiResponse":
        this.extensionUi.respond(message.id, message);
        break;
    }
  }

  private async sendPrompt(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt) return;
    await this.ensureStarted();
    const client = this.runtime.client;
    if (!client?.running) return;

    const owner = this.runtimeManager.writeLeaseOwner;
    if (owner && owner !== this.runtimeManager.activeId && !prompt.startsWith("/")) {
      this.post({ type: "notice", message: "Another PiDE session is working in this workspace. This prompt is queued until the write lease is free." });
      setTimeout(() => void this.sendPrompt(text), 2_000);
      return;
    }

    if (
      !this.state.isStreaming
      && !prompt.startsWith("/")
      && vscode.workspace.getConfiguration("pide").get<boolean>("gitCheckpoints", true)
    ) {
      const folder = this.workspaceFolder();
      if (folder) {
        await this.changeReview.begin(prompt).catch((error) => {
          this.output.appendLine(`[Git checkpoint] ${errorMessage(error)}`);
          this.post({ type: "notice", message: `Git checkpoint unavailable: ${errorMessage(error)}` });
        });
      }
    }

    const message = await this.withMentionedContexts(prompt);
    if (!this.state.sessionName && this.state.sessionFile) {
      void client.request({ type: "set_session_name", name: prompt.replace(/\s+/g, " ").slice(0, 72) }).then(() => this.refreshState()).catch(() => undefined);
    }
    this.post({ type: "userPrompt", text: prompt });
    this.post({ type: "busy", value: true });

    const command: Record<string, unknown> = { type: "prompt", message };
    if (this.state.isStreaming) command.streamingBehavior = "followUp";
    try {
      await client.request(command);
    } catch (error) {
      this.showError(error);
      this.post({ type: "busy", value: false });
    }
  }

  private async pickModel(): Promise<void> {
    await this.ensureStarted();
    const client = this.runtime.client;
    if (!client?.running) return;
    const response = await client.request({ type: "get_available_models" }, 60_000);
    const models = asArray(asRecord(response.data).models).map((raw) => asRecord(raw));
    const selected = await vscode.window.showQuickPick(
      models.map((model) => ({
        label: String(model.name ?? model.id ?? "Unknown model"),
        description: `${String(model.provider ?? "unknown")}/${String(model.id ?? "unknown")}`,
        detail: model.reasoning === true ? "Reasoning model" : undefined,
        provider: String(model.provider ?? ""),
        modelId: String(model.id ?? ""),
      })),
      {
        title: "Select Pi Model",
        placeHolder: "Type to filter configured models",
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (!selected) return;
    await client.request({ type: "set_model", provider: selected.provider, modelId: selected.modelId });
    await this.refreshState();
  }

  private async pickThinking(): Promise<void> {
    await this.ensureStarted();
    const client = this.runtime.client;
    if (!client?.running) return;
    const response = await client.request({ type: "get_available_thinking_levels" });
    const levels = asArray(asRecord(response.data).levels).map(String);
    const selected = await vscode.window.showQuickPick(levels, {
      title: "Select Pi Reasoning Level",
      placeHolder: this.state.thinkingLevel,
    });
    if (!selected) return;
    await client.request({ type: "set_thinking_level", level: selected });
    await this.refreshState();
  }

  private async refreshState(): Promise<void> {
    const response = await this.runtime.client?.request({ type: "get_state" });
    if (!response) return;
    this.state = asRecord(response.data) as PiState;
    this.runtimeManager.ensureTab({ id: this.runtimeManager.activeId, sessionFile: this.state.sessionFile, title: this.state.sessionName || (this.state.sessionFile ? basename(this.state.sessionFile).replace(/\.jsonl$/i, "") : undefined) });
    this.postTabs();
    if (this.state.sessionFile) await this.sessions.rememberCurrent();
    await this.refreshSessionStats();
    this.postState();
  }

  private async refreshCommands(): Promise<void> {
    const response = await this.runtime.client?.request({ type: "get_commands" });
    if (!response) return;
    this.availableCommands = asArray(asRecord(response.data).commands).map((command) => {
      const item = asRecord(command);
      return {
        name: String(item.name ?? ""),
        description: typeof item.description === "string" ? item.description : undefined,
        source: typeof item.source === "string" ? item.source : undefined,
      };
    });
    this.post({ type: "commands", commands: this.availableCommands });
    this.mcp.postPrompts(this.availableCommands);
  }

  private async handleRpcRecord(record: RpcRecord): Promise<void> {
    switch (record.type) {
      case "agent_start":
        this.runtimeManager.markWorking(this.runtimeManager.activeId, true);
        this.postTabs();
        this.state.isStreaming = true;
        this.post({ type: "busy", value: true });
        break;
      case "agent_settled": {
        this.runtimeManager.markWorking(this.runtimeManager.activeId, false);
        this.postTabs();
        this.state.isStreaming = false;
        this.post({ type: "busy", value: false });
        const changeSet = await this.changeReview.finish().catch((error) => {
          this.output.appendLine(`[Git checkpoint] Could not calculate changes: ${errorMessage(error)}`);
          return undefined;
        });
        if (changeSet?.files.length) this.post({ type: "changeSet", changeSet });
        else if (changeSet) this.post({ type: "hideChanges" });
        await this.refreshState().catch(() => undefined);
        break;
      }
      case "message_update": {
        const event = asRecord(record.assistantMessageEvent);
        if (event.type === "text_delta" && typeof event.delta === "string") {
          this.post({ type: "textDelta", delta: event.delta });
        } else if (
          event.type === "thinking_delta"
          && typeof event.delta === "string"
          && vscode.workspace.getConfiguration("pide").get<boolean>("showThinking", true)
        ) {
          this.post({ type: "thinkingDelta", delta: event.delta });
        }
        break;
      }
      case "message_end":
        this.post({ type: "messageEnd", role: asRecord(record.message).role });
        break;
      case "tool_execution_start":
        this.post({
          type: "toolStart",
          id: record.toolCallId,
          name: record.toolName,
          args: sanitizeForUi(record.args),
        });
        break;
      case "tool_execution_update":
        this.post({
          type: "toolUpdate",
          id: record.toolCallId,
          result: sanitizeForUi(record.partialResult),
        });
        break;
      case "tool_execution_end":
        this.post({
          type: "toolEnd",
          id: record.toolCallId,
          result: sanitizeForUi(record.result),
          isError: record.isError === true,
        });
        break;
      case "queue_update":
        this.post({ type: "queue", steering: record.steering, followUp: record.followUp });
        break;
      case "compaction_start":
        this.state.isCompacting = true;
        this.postState();
        this.post({ type: "notice", message: `Compacting context (${String(record.reason ?? "manual")})…` });
        break;
      case "compaction_end":
        this.state.isCompacting = false;
        this.postState();
        await this.refreshSessionStats().catch(() => undefined);
        break;
      case "auto_retry_start":
        this.state.isRetrying = true;
        this.postState();
        this.post({ type: "notice", message: `Retrying in ${String(record.delayMs ?? "")}ms…` });
        break;
      case "auto_retry_end":
        this.state.isRetrying = false;
        this.postState();
        break;
      case "extension_error":
        this.post({ type: "error", message: String(record.error ?? "A Pi extension failed") });
        break;
      case "extension_ui_request":
        await this.extensionUi.handle(record);
        break;
      case "client_error":
        this.post({ type: "error", message: String(record.error ?? "Pi RPC error") });
        break;
    }
  }

  private async revertChange(path: string): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Revert Pi's changes to ${path}?`,
      { modal: true, detail: "The file will be restored to the checkpoint captured immediately before this Pi task." },
      "Revert File",
    );
    if (confirm !== "Revert File") return;
    const changeSet = await this.changeReview.revert(path);
    if (changeSet) {
      this.post({ type: "changeSet", changeSet });
      if (!changeSet.files.length) this.post({ type: "hideChanges" });
    }
  }

  private async searchContexts(query: string, requestId: string): Promise<void> {
    const normalized = query.toLowerCase().trim();
    const builtins: ContextCompletion[] = [
      { label: "selection", description: "Selected editor text", insertText: "@selection", kind: "context" },
      { label: "current-file", description: "Current editor, including unsaved changes", insertText: "@current-file", kind: "context" },
      { label: "open-files", description: "Files open in editor tabs", insertText: "@open-files", kind: "context" },
      { label: "problems", description: "Workspace errors and warnings", insertText: "@problems", kind: "context" },
      { label: "git-diff", description: "Current staged and unstaged Git diff", insertText: "@git-diff", kind: "context" },
      { label: "terminal", description: "Active terminal metadata", insertText: "@terminal", kind: "context" },
      { label: "workspace", description: "Workspace roots", insertText: "@workspace", kind: "context" },
    ];
    const files = await this.workspaceFileContexts();
    const items = [...builtins, ...files]
      .map((item) => ({ item, score: contextScore(item, normalized) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
      .slice(0, 14)
      .map(({ item }) => ({
        label: item.label,
        description: item.description,
        insertText: item.insertText,
        kind: item.kind,
      }));
    this.post({ type: "contextResults", requestId, items });
  }

  private async workspaceFileContexts(): Promise<ContextCompletion[]> {
    if (this.fileContextCache && this.fileContextCache.expiresAt > Date.now()) {
      return this.fileContextCache.items;
    }
    const uris = await vscode.workspace.findFiles(
      "**/*",
      "{**/.git/**,**/node_modules/**,**/vendor/**,**/dist/**,**/build/**,**/.cache/**,**/coverage/**}",
      5_000,
    );
    const includeRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const items = uris.map((uri) => {
      const label = vscode.workspace.asRelativePath(uri, includeRoot);
      return {
        label,
        description: `File · ${basename(label)}`,
        insertText: mentionText(label),
        kind: "file" as const,
        uri,
      };
    });
    this.fileContextCache = { expiresAt: Date.now() + 30_000, items };
    return items;
  }

  private async withMentionedContexts(prompt: string): Promise<string> {
    const mentions = extractMentions(prompt);
    if (!mentions.length) return prompt;
    const sections: string[] = [];
    let remaining = 120_000;
    for (const mention of mentions) {
      if (remaining <= 0) break;
      const content = await this.resolveMention(mention).catch((error) => `Unable to attach @${mention}: ${errorMessage(error)}`);
      if (!content) continue;
      const bounded = truncateContext(content, Math.min(remaining, 50_000));
      remaining -= bounded.length;
      sections.push(`--- BEGIN VS CODE CONTEXT @${mention} ---\n${bounded}\n--- END VS CODE CONTEXT @${mention} ---`);
    }
    return sections.length ? `${prompt}\n\n${sections.join("\n\n")}` : prompt;
  }

  private async resolveMention(mention: string): Promise<string | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (mention === "selection") {
      if (!editor || editor.selection.isEmpty) return "No editor text is currently selected.";
      const file = vscode.workspace.asRelativePath(editor.document.uri, true);
      const range = `lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`;
      return `File: ${file}\nLanguage: ${editor.document.languageId}\nSelection: ${range}\n\n${editor.document.getText(editor.selection)}`;
    }
    if (mention === "current-file") {
      if (!editor) return "No text editor is currently active.";
      const file = vscode.workspace.asRelativePath(editor.document.uri, true);
      return `File: ${file}\nLanguage: ${editor.document.languageId}\nDirty: ${editor.document.isDirty}\n\n${editor.document.getText()}`;
    }
    if (mention === "open-files") {
      const paths = vscode.window.tabGroups.all.flatMap((group) => group.tabs).flatMap((tab) => {
        const input = tab.input;
        return input instanceof vscode.TabInputText ? [vscode.workspace.asRelativePath(input.uri, true)] : [];
      });
      return paths.length ? `Open editor files:\n${Array.from(new Set(paths)).map((path) => `- ${path}`).join("\n")}` : "No text files are open.";
    }
    if (mention === "problems") {
      const problems: string[] = [];
      for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
        if (!vscode.workspace.getWorkspaceFolder(uri)) continue;
        const file = vscode.workspace.asRelativePath(uri, true);
        for (const diagnostic of diagnostics) {
          const severity = ["Error", "Warning", "Information", "Hint"][diagnostic.severity] ?? "Diagnostic";
          problems.push(`${file}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} [${severity}] ${diagnostic.message}`);
          if (problems.length >= 200) break;
        }
        if (problems.length >= 200) break;
      }
      return problems.length ? `Workspace diagnostics:\n${problems.join("\n")}` : "VS Code reports no workspace diagnostics.";
    }
    if (mention === "git-diff") {
      const folder = this.workspaceFolder();
      if (!folder) return "No workspace folder is open.";
      const diff = await gitDiff(folder.uri.fsPath);
      return diff.trim() ? `Git diff for ${folder.name}:\n\n${diff}` : "The current workspace Git diff is empty.";
    }
    if (mention === "terminal") {
      const terminal = vscode.window.activeTerminal;
      return terminal
        ? `Active terminal: ${terminal.name}\nProcess ID: ${String(await terminal.processId ?? "unknown")}\nNote: VS Code's stable API does not expose terminal buffer contents.`
        : "No terminal is currently active.";
    }
    if (mention === "workspace") {
      const roots = vscode.workspace.workspaceFolders ?? [];
      return roots.length
        ? `Workspace roots:\n${roots.map((folder) => `- ${folder.name}: ${folder.uri.fsPath}`).join("\n")}`
        : "No workspace is open.";
    }

    const files = await this.workspaceFileContexts();
    const normalized = mention.replace(/^\.\//, "");
    const match = files.find((item) => item.label === normalized || item.label.toLowerCase() === normalized.toLowerCase());
    if (!match?.uri) return undefined;
    const bytes = await vscode.workspace.fs.readFile(match.uri);
    const buffer = Buffer.from(bytes);
    if (buffer.includes(0)) return `File ${match.label} appears to be binary and was not attached.`;
    return `File: ${match.label}\n\n${buffer.toString("utf8")}`;
  }

  private async openLink(href: string): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(href, true);
    } catch {
      return;
    }
    if (!["https", "http", "mailto"].includes(uri.scheme)) return;
    await vscode.env.openExternal(uri);
  }

  private async openSessionTab(session: { file: string; id?: string; name?: string }): Promise<void> {
    const tab = this.runtimeManager.ensureTab({ id: `session:${session.file}`, sessionFile: session.file, title: session.name || basename(session.file).replace(/\.jsonl$/i, "") });
    this.runtimeManager.activate(tab.id);
    this.postTabs();
    await this.ensureStarted();
    await this.refresh();
  }

  private async activateTab(id: string): Promise<void> {
    if (!this.runtimeManager.activate(id)) return;
    this.postTabs();
    if (this.runtime.running) await this.refresh().catch((error) => this.showError(error));
    else await this.ensureStarted().catch((error) => this.showError(error));
  }

  private async compactSession(): Promise<void> {
    const client = this.runtime.client;
    if (!client?.running || this.state.isStreaming || this.state.isCompacting) return;
    await client.request({ type: "compact" }, 120_000);
  }

  private async reloadSession(): Promise<void> {
    const client = this.runtime.client;
    const sessionPath = this.state.sessionFile;
    if (!client?.running || !sessionPath || this.state.isStreaming || this.state.isCompacting) return;
    const response = await client.request({ type: "switch_session", sessionPath });
    if (asRecord(response.data).cancelled !== true) await this.refresh();
  }

  private async refreshSessionStats(): Promise<void> {
    const response = await this.runtime.client?.request({ type: "get_session_stats" }).catch(() => undefined);
    if (!response) return;
    const raw = asRecord(response.data);
    const contextUsage = asRecord(raw.contextUsage);
    this.sessionStats = {
      tokens: numberValue(asRecord(raw.tokens).total),
      cost: numberValue(raw.cost),
      contextUsage: Object.keys(contextUsage).length ? {
        tokens: nullableNumber(contextUsage.tokens),
        contextWindow: numberValue(contextUsage.contextWindow),
        percent: nullableNumber(contextUsage.percent),
      } : undefined,
    };
    this.post({ type: "sessionStats", stats: this.sessionStats });
  }

  private postTabs(): void {
    void this.context.workspaceState.update("pide.runtimeTabs", this.runtimeManager.allTabs.map((tab) => ({ id: tab.id, sessionFile: tab.sessionFile, title: tab.title, lastActive: tab.lastActive })));
    void this.context.workspaceState.update("pide.activeRuntimeTab", this.runtimeManager.activeId);
    this.post({
      type: "sessionTabs",
      tabs: this.runtimeManager.allTabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        status: tab.status,
        unread: tab.unread,
        active: tab.id === this.runtimeManager.activeId,
      })),
    });
  }

  private postState(): void {
    this.post({
      type: "state",
      model: this.state.model,
      thinkingLevel: this.state.thinkingLevel,
      isStreaming: this.state.isStreaming,
      isCompacting: this.state.isCompacting,
      isRetrying: this.state.isRetrying,
      autoCompactionEnabled: this.state.autoCompactionEnabled,
      autoRetryEnabled: this.state.autoRetryEnabled,
      sessionId: this.state.sessionId,
      sessionName: this.state.sessionName,
    });
  }

  private post(message: HostToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private showError(error: unknown): void {
    const message = errorMessage(error);
    this.output.appendLine(`[${new Date().toISOString()}] Error: ${message}`);
    this.post({ type: "error", message });
  }

  private workspaceFolder(): vscode.WorkspaceFolder | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return (activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined)
      ?? vscode.workspace.workspaceFolders?.[0];
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const nonce = randomNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>PiDE</title>
</head>
<body>
  <header class="topbar">
    <div class="brand"><span class="status-dot" id="status-dot"></span><strong>PiDE</strong></div>
    <div class="actions">
      <button id="sessions" title="Session library">◷</button>
      <button id="resources" title="PiDE control center">⚙</button>
      <button id="agent-lab" title="Agent Lab">⚗</button>
      <button id="compact" title="Compact session context">⇣</button>
      <button id="reload-session" title="Reload session context">↻</button>
      <button id="changes" class="hidden" title="Review changes">Δ</button>
      <button id="mcp" title="MCP control center">⌁</button>
      <button id="new" title="New session">＋</button>
      <button id="restart" title="Restart Pi">↻</button>
      <button id="output" title="Show output">⋯</button>
    </div>
  </header>
  <section id="session-tabs" class="session-tabs hidden"></section>
  <section class="selectors">
    <button id="model" class="selector">Select model</button>
    <button id="thinking" class="selector">thinking: —</button>
    <span id="session-stats" class="session-stats" title="Session context usage">context: —</span>
  </section>
  <div id="banner" class="banner">Starting Pi…</div>
  <section id="runtime-health" class="runtime-health hidden" aria-live="polite">
    <strong id="runtime-health-title">Pi runtime unavailable</strong>
    <p id="runtime-health-message"></p>
    <div id="runtime-health-details" class="runtime-health-details"></div>
    <div class="runtime-health-actions">
      <button id="runtime-trust" class="hidden">Manage Workspace Trust</button>
      <button id="runtime-settings">Open Settings</button>
      <button id="runtime-retry">Retry</button>
    </div>
  </section>
  <div id="widget" class="widget hidden"></div>
  <section id="extension-request" class="control-panel hidden" aria-live="assertive"></section>
  <div id="change-summary" class="change-summary hidden"></div>
  <main id="transcript" aria-live="polite"></main>
  <div id="jump" class="jump hidden"><button>Jump to latest</button></div>
  <section id="changes-panel" class="control-panel hidden" aria-label="PiDE changes">
    <header><strong>PiDE Changes</strong><button data-close-panel="changes-panel">×</button></header>
    <div id="changes-totals" class="panel-summary"></div>
    <div id="changes-list" class="panel-list"></div>
  </section>
  <section id="agent-lab-panel" class="control-panel hidden" aria-label="Agent Lab">
    <header><strong>Agent Lab</strong><button data-close-panel="agent-lab-panel">×</button></header>
    <div id="agent-lab-summary" class="panel-summary">Read-only subagents are ready.</div>
    <textarea id="agent-lab-task" rows="4" placeholder="Ask selected read-only subagents to investigate…"></textarea>
    <div id="agent-lab-roles" class="panel-list compact"></div>
    <div class="panel-toolbar"><button id="agent-lab-run">Run selected</button><button id="agent-lab-stop">Stop all</button><button id="agent-lab-refresh">Refresh</button></div>
    <div id="agent-lab-runs" class="panel-list"></div>
  </section>
  <section id="mcp-panel" class="control-panel hidden" aria-label="MCP control center">
    <header><strong>MCP Control Center</strong><button data-close-panel="mcp-panel">×</button></header>
    <div id="mcp-totals" class="panel-summary">Waiting for MCP status…</div>
    <div class="panel-toolbar"><button id="mcp-reconnect-all">Reconnect all</button><button id="mcp-config">Config</button></div>
    <div id="mcp-list" class="panel-list"></div>
    <div class="panel-section-title">Prompts</div>
    <div id="mcp-prompts" class="panel-list compact"></div>
  </section>
  <footer class="composer-shell">
    <div id="context-chips" class="context-chips hidden"></div>
    <textarea id="prompt" rows="3" placeholder="Ask Pi…  (@ for context, / for commands)" aria-label="Message Pi"></textarea>
    <div class="composer-actions">
      <button id="attach" title="Attach current editor context">@</button>
      <span id="queue" class="queue"></span>
      <button id="stop" class="stop hidden">Stop</button>
      <button id="send" class="send">Send</button>
    </div>
    <div id="command-menu" class="completion-menu hidden"></div>
    <div id="context-menu" class="completion-menu hidden"></div>
  </footer>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function normalizeMessage(raw: unknown): NormalizedMessage | undefined {
  const message = asRecord(raw);
  const role = String(message.role ?? "unknown");
  const content = message.content;
  let text = "";
  let thinking = "";
  if (typeof content === "string") text = content;
  else {
    for (const blockRaw of asArray(content)) {
      const block = asRecord(blockRaw);
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      if (block.type === "thinking" && typeof block.thinking === "string") thinking += block.thinking;
      if (block.type === "image") text += "[Image attachment]";
      if (block.type === "toolCall") text += text ? "" : `Using ${String(block.name ?? "tool")}…`;
    }
  }
  if (role === "toolResult") {
    return {
      role,
      text: text || "Tool completed",
      toolName: String(message.toolName ?? "tool"),
      isError: message.isError === true,
    };
  }
  if (!text && !thinking && role !== "assistant") return undefined;
  return { role, text, thinking: thinking || undefined };
}

function sanitizeForUi(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested data omitted]";
  if (Array.isArray(value)) return value.map((item) => sanitizeForUi(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/(api[-_]?key|password|secret|authorization|access[-_]?token|refresh[-_]?token)/i.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = sanitizeForUi(item, depth + 1);
    }
  }
  return output;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : numberValue(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitDiff(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, "diff", "--no-ext-diff", "--unified=3", "HEAD"],
      { timeout: 20_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function randomNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
