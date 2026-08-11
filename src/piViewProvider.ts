import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import * as vscode from "vscode";
import { contextScore, extractMentions, mentionText, truncateContext } from "./contextMentions";
import { PiRpcClient, type RpcRecord } from "./piRpcClient";

interface PiState {
  model?: { id?: string; name?: string; provider?: string } | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
}

interface NormalizedMessage {
  role: string;
  text: string;
  thinking?: string;
  toolName?: string;
  isError?: boolean;
}

interface StoredSession {
  file: string;
  id?: string;
  name?: string;
  updatedAt: number;
}

interface ContextCompletion {
  label: string;
  description: string;
  insertText: string;
  kind: "context" | "file";
  uri?: vscode.Uri;
}

export class PiViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "pi.chatView";

  private view?: vscode.WebviewView;
  private client?: PiRpcClient;
  private startPromise?: Promise<void>;
  private state: PiState = {};
  private disposed = false;
  private unsubscribeRecord?: () => void;
  private unsubscribeExit?: () => void;
  private fileContextCache?: { expiresAt: number; items: ContextCompletion[] };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

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
    await vscode.commands.executeCommand("workbench.view.extension.pi");
    this.view?.show?.(true);
  }

  async newSession(): Promise<void> {
    await this.ensureStarted();
    if (!this.client) return;
    if (this.state.isStreaming) {
      const choice = await vscode.window.showWarningMessage(
        "Pi is still working. Stop it and start a new session?",
        { modal: true },
        "Stop and Start New",
      );
      if (!choice) return;
      await this.abort();
    }
    const response = await this.client.request({ type: "new_session" });
    const data = asRecord(response.data);
    if (data.cancelled === true) return;
    this.post({ type: "clear" });
    await this.refresh();
  }

  async openSession(): Promise<void> {
    await this.ensureStarted();
    const folder = this.workspaceFolder();
    const client = this.client;
    if (!folder || !client?.running) return;
    const sessions = this.context.workspaceState.get<StoredSession[]>(this.sessionsStorageKey(folder.uri), []);
    if (!sessions.length) {
      void vscode.window.showInformationMessage("No Pi sessions have been opened from this VS Code workspace yet.");
      return;
    }

    const selected = await vscode.window.showQuickPick(
      sessions
        .filter((session) => existsSync(session.file))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((session) => ({
          label: session.name || `Pi session ${shortId(session.id)}`,
          description: session.file === this.state.sessionFile ? "Current session" : relativeTime(session.updatedAt),
          detail: session.file,
          session,
        })),
      { title: "Open Pi Session", placeHolder: "Select a recent workspace chat" },
    );
    if (!selected || selected.session.file === this.state.sessionFile) return;
    if (this.state.isStreaming) {
      const stop = await vscode.window.showWarningMessage(
        "Pi is still working. Stop it and switch sessions?",
        { modal: true },
        "Stop and Switch",
      );
      if (!stop) return;
      await this.abort();
    }

    const response = await client.request({ type: "switch_session", sessionPath: selected.session.file });
    if (asRecord(response.data).cancelled === true) return;
    this.post({ type: "clear" });
    await this.refresh();
  }

  async abort(): Promise<void> {
    if (!this.client?.running) return;
    await this.client.request({ type: "abort" }).catch((error) => this.showError(error));
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
    await this.stopClient();
  }

  private async ensureStarted(): Promise<void> {
    if (this.client?.running) return;
    if (this.startPromise) return await this.startPromise;

    this.startPromise = this.startClient().finally(() => {
      this.startPromise = undefined;
    });
    return await this.startPromise;
  }

  private async startClient(): Promise<void> {
    if (this.disposed) return;
    if (!vscode.workspace.isTrusted) {
      this.post({
        type: "connection",
        status: "untrusted",
        message: "Trust this workspace to start Pi.",
      });
      return;
    }

    const folder = this.workspaceFolder();
    if (!folder) {
      this.post({ type: "connection", status: "error", message: "Open a folder or workspace to use Pi." });
      return;
    }

    const config = vscode.workspace.getConfiguration("pi", folder.uri);
    const executable = config.get<string>("executablePath", "pi").trim() || "pi";
    const extraArgs = config.get<string[]>("extraArgs", []);
    const approveWorkspace = config.get<boolean>("approveTrustedWorkspace", true);
    const sessionKey = this.sessionStorageKey(folder.uri);
    const savedSession = this.context.workspaceState.get<string>(sessionKey);
    const sessionFile = savedSession && existsSync(savedSession) ? savedSession : undefined;

    const client = new PiRpcClient((line) => this.output.appendLine(`[${new Date().toISOString()}] ${line}`));
    this.client = client;
    this.unsubscribeRecord = client.onRecord((record) => void this.handleRpcRecord(record));
    this.unsubscribeExit = client.onExit(({ expected }) => {
      this.post({
        type: "connection",
        status: expected ? "stopped" : "error",
        message: expected ? "Pi stopped." : "Pi exited unexpectedly. Use Restart Agent to reconnect.",
      });
    });

    this.post({ type: "connection", status: "starting", message: "Starting Pi…" });
    client.start({
      executable,
      cwd: folder.uri.fsPath,
      args: extraArgs,
      sessionFile,
      approveWorkspace,
    });

    try {
      await this.refresh();
      this.post({ type: "connection", status: "ready", message: "Pi is ready." });
    } catch (error) {
      this.showError(error);
      this.post({
        type: "connection",
        status: "error",
        message: `Could not start Pi: ${errorMessage(error)}`,
      });
    }
  }

  private async stopClient(): Promise<void> {
    this.unsubscribeRecord?.();
    this.unsubscribeRecord = undefined;
    this.unsubscribeExit?.();
    this.unsubscribeExit = undefined;
    const client = this.client;
    this.client = undefined;
    if (client) await client.stop();
  }

  private async refresh(): Promise<void> {
    const client = this.client;
    if (!client?.running) throw new Error("Pi is not running");
    const [stateResponse, messagesResponse, commandsResponse] = await Promise.all([
      client.request({ type: "get_state" }),
      client.request({ type: "get_messages" }),
      client.request({ type: "get_commands" }),
    ]);

    this.state = asRecord(stateResponse.data) as PiState;
    const sessionFile = this.state.sessionFile;
    const folder = this.workspaceFolder();
    if (sessionFile && folder) {
      await this.context.workspaceState.update(this.sessionStorageKey(folder.uri), sessionFile);
      await this.rememberSession(folder.uri);
    }

    const messages = asArray(asRecord(messagesResponse.data).messages).map(normalizeMessage).filter(Boolean);
    const commands = asArray(asRecord(commandsResponse.data).commands).map((command) => {
      const item = asRecord(command);
      return {
        name: String(item.name ?? ""),
        description: typeof item.description === "string" ? item.description : undefined,
        source: typeof item.source === "string" ? item.source : undefined,
      };
    });

    this.post({ type: "history", messages });
    this.post({ type: "commands", commands });
    this.postState();
  }

  private async handleWebviewMessage(raw: unknown): Promise<void> {
    const message = asRecord(raw);
    switch (message.type) {
      case "ready":
        await this.ensureStarted();
        if (this.client?.running) {
          await this.refresh().catch((error) => this.showError(error));
          this.post({ type: "connection", status: "ready", message: "Pi is ready." });
        }
        break;
      case "prompt":
        await this.sendPrompt(String(message.text ?? ""));
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
        await this.searchContexts(String(message.query ?? ""), String(message.requestId ?? ""));
        break;
      case "copyText":
        await vscode.env.clipboard.writeText(String(message.text ?? ""));
        break;
      case "insertText": {
        const editor = vscode.window.activeTextEditor;
        if (editor) await editor.edit((edit) => edit.insert(editor.selection.active, String(message.text ?? "")));
        break;
      }
      case "openLink":
        await this.openLink(String(message.href ?? ""));
        break;
      case "showOutput":
        this.output.show(true);
        break;
    }
  }

  private async sendPrompt(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt) return;
    await this.ensureStarted();
    const client = this.client;
    if (!client?.running) return;

    const message = await this.withMentionedContexts(prompt);
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
    const client = this.client;
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
    const client = this.client;
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
    const response = await this.client?.request({ type: "get_state" });
    if (!response) return;
    this.state = asRecord(response.data) as PiState;
    const folder = this.workspaceFolder();
    if (folder && this.state.sessionFile) await this.rememberSession(folder.uri);
    this.postState();
  }

  private async handleRpcRecord(record: RpcRecord): Promise<void> {
    switch (record.type) {
      case "agent_start":
        this.state.isStreaming = true;
        this.post({ type: "busy", value: true });
        break;
      case "agent_settled":
        this.state.isStreaming = false;
        this.post({ type: "busy", value: false });
        await this.refreshState().catch(() => undefined);
        break;
      case "message_update": {
        const event = asRecord(record.assistantMessageEvent);
        if (event.type === "text_delta" && typeof event.delta === "string") {
          this.post({ type: "textDelta", delta: event.delta });
        } else if (
          event.type === "thinking_delta"
          && typeof event.delta === "string"
          && vscode.workspace.getConfiguration("pi").get<boolean>("showThinking", true)
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
        this.post({ type: "notice", message: `Compacting context (${String(record.reason ?? "manual")})…` });
        break;
      case "auto_retry_start":
        this.post({ type: "notice", message: `Retrying in ${String(record.delayMs ?? "")}ms…` });
        break;
      case "extension_error":
        this.post({ type: "error", message: String(record.error ?? "A Pi extension failed") });
        break;
      case "extension_ui_request":
        await this.handleExtensionUi(record);
        break;
      case "client_error":
        this.post({ type: "error", message: String(record.error ?? "Pi RPC error") });
        break;
    }
  }

  private async handleExtensionUi(request: RpcRecord): Promise<void> {
    const client = this.client;
    const id = request.id;
    if (!client || typeof id !== "string") return;
    const method = String(request.method ?? "");

    if (method === "confirm") {
      const allow = await vscode.window.showWarningMessage(
        [request.title, request.message].filter(Boolean).map(String).join("\n\n"),
        { modal: true },
        "Allow",
      );
      client.send({ type: "extension_ui_response", id, confirmed: allow === "Allow" });
      return;
    }
    if (method === "select") {
      const value = await vscode.window.showQuickPick(asArray(request.options).map(String), {
        title: String(request.title ?? "Pi needs input"),
      });
      client.send(value === undefined
        ? { type: "extension_ui_response", id, cancelled: true }
        : { type: "extension_ui_response", id, value });
      return;
    }
    if (method === "input" || method === "editor") {
      const value = await vscode.window.showInputBox({
        title: String(request.title ?? "Pi needs input"),
        prompt: typeof request.message === "string" ? request.message : undefined,
        placeHolder: typeof request.placeholder === "string" ? request.placeholder : undefined,
        value: typeof request.prefill === "string" ? request.prefill : undefined,
        ignoreFocusOut: true,
      });
      client.send(value === undefined
        ? { type: "extension_ui_response", id, cancelled: true }
        : { type: "extension_ui_response", id, value });
      return;
    }
    if (method === "notify") {
      const text = String(request.message ?? "");
      if (request.notifyType === "error") void vscode.window.showErrorMessage(text);
      else if (request.notifyType === "warning") void vscode.window.showWarningMessage(text);
      else void vscode.window.showInformationMessage(text);
      return;
    }
    if (method === "setStatus") {
      this.post({ type: "extensionStatus", key: request.statusKey, text: request.statusText });
      return;
    }
    if (method === "setWidget") {
      this.post({ type: "widget", key: request.widgetKey, lines: request.widgetLines });
      return;
    }
    if (method === "set_editor_text") {
      this.post({ type: "prefill", text: request.text });
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

  private postState(): void {
    this.post({
      type: "state",
      model: this.state.model,
      thinkingLevel: this.state.thinkingLevel,
      isStreaming: this.state.isStreaming,
      sessionId: this.state.sessionId,
      sessionName: this.state.sessionName,
    });
  }

  private post(message: Record<string, unknown>): void {
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

  private sessionStorageKey(uri: vscode.Uri): string {
    return `pi.sessionFile:${uri.toString()}`;
  }

  private sessionsStorageKey(uri: vscode.Uri): string {
    return `pi.sessions:${uri.toString()}`;
  }

  private async rememberSession(uri: vscode.Uri): Promise<void> {
    const file = this.state.sessionFile;
    if (!file) return;
    const key = this.sessionsStorageKey(uri);
    const sessions = this.context.workspaceState.get<StoredSession[]>(key, []);
    const current: StoredSession = {
      file,
      id: this.state.sessionId,
      name: this.state.sessionName,
      updatedAt: Date.now(),
    };
    const next = [current, ...sessions.filter((session) => session.file !== file)].slice(0, 50);
    await this.context.workspaceState.update(key, next);
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
  <title>Pi Chat</title>
</head>
<body>
  <header class="topbar">
    <div class="brand"><span class="status-dot" id="status-dot"></span><strong>Pi</strong></div>
    <div class="actions">
      <button id="sessions" title="Open session">◷</button>
      <button id="new" title="New session">＋</button>
      <button id="restart" title="Restart Pi">↻</button>
      <button id="output" title="Show output">⋯</button>
    </div>
  </header>
  <section class="selectors">
    <button id="model" class="selector">Select model</button>
    <button id="thinking" class="selector">thinking: —</button>
  </section>
  <div id="banner" class="banner">Starting Pi…</div>
  <div id="widget" class="widget hidden"></div>
  <main id="transcript" aria-live="polite"></main>
  <div id="jump" class="jump hidden"><button>Jump to latest</button></div>
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

function shortId(id: string | undefined): string {
  return id ? id.slice(0, 8) : "unknown";
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function randomNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
