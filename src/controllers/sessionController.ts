import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { PiState } from "../protocol";
import { truncateContext } from "../contextMentions";
import { PiRpcClient } from "../piRpcClient";
import { resolvePiExecutable } from "../runtime/piExecutable";
import { archiveSession, discoverSessions, restoreArchivedSession, type SessionSummary } from "../sessionLibrary";

interface StoredSession {
  file: string;
  id?: string;
  name?: string;
  updatedAt: number;
}

type SessionSort = "recent" | "name" | "cost";

interface SessionPreferences {
  pinned: string[];
  favorites: string[];
  sort: SessionSort;
}

const execFileAsync = promisify(execFile);

export interface SessionControllerDependencies {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  workspaceFolder: () => vscode.WorkspaceFolder | undefined;
  client: () => PiRpcClient | undefined;
  state: () => PiState;
  abort: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshState: () => Promise<void>;
  post: (message: Record<string, unknown>) => void;
}

export class SessionController {
  constructor(private readonly dependencies: SessionControllerDependencies) {}

  async restoreSessionFile(): Promise<string | undefined> {
    const folder = this.dependencies.workspaceFolder();
    if (!folder) return undefined;
    const saved = this.dependencies.context.workspaceState.get<string>(this.sessionStorageKey(folder.uri));
    return saved && existsSync(saved) ? saved : undefined;
  }

  async rememberCurrent(): Promise<void> {
    const folder = this.dependencies.workspaceFolder();
    const state = this.dependencies.state();
    const file = state.sessionFile;
    if (!folder || !file) return;
    await this.dependencies.context.workspaceState.update(this.sessionStorageKey(folder.uri), file);
    const key = this.sessionsStorageKey(folder.uri);
    const sessions = this.dependencies.context.workspaceState.get<StoredSession[]>(key, []);
    const current: StoredSession = {
      file,
      id: state.sessionId,
      name: state.sessionName,
      updatedAt: Date.now(),
    };
    await this.dependencies.context.workspaceState.update(
      key,
      [current, ...sessions.filter((session) => session.file !== file)].slice(0, 50),
    );
  }

  async openLibrary(): Promise<void> {
    const folder = this.dependencies.workspaceFolder();
    if (!folder || !this.dependencies.client()?.running) return;
    const sessions = await discoverSessions({
      cwd: folder.uri.fsPath,
      currentSessionFile: this.dependencies.state().sessionFile,
      agentDir: process.env.PI_CODING_AGENT_DIR,
    });
    if (!sessions.length) {
      void vscode.window.showInformationMessage("No Pi CLI sessions were found for this workspace.");
      return;
    }
    const preferences = this.sessionPreferences(folder.uri);
    const selection = await this.pickSessionAction(sessions, preferences, folder.uri);
    if (selection) await this.handleAction(selection.session, selection.action, folder.uri);
  }

  async newSession(): Promise<void> {
    const client = this.dependencies.client();
    if (!client) return;
    if (this.dependencies.state().isStreaming) {
      const choice = await vscode.window.showWarningMessage(
        "Pi is still working. Stop it and start a new session?",
        { modal: true },
        "Stop and Start New",
      );
      if (!choice) return;
      await this.dependencies.abort();
    }
    const response = await client.request({ type: "new_session" });
    if (recordValue(response.data).cancelled === true) return;
    this.dependencies.post({ type: "clear" });
    await this.dependencies.refresh();
  }

  private async handleAction(session: SessionSummary, action: string, workspaceUri: vscode.Uri): Promise<void> {
    if (action === "pin" || action === "favorite") {
      const preferences = this.sessionPreferences(workspaceUri);
      const key = action === "pin" ? "pinned" : "favorites";
      preferences[key] = toggle(preferences[key], session.file);
      await this.saveSessionPreferences(workspaceUri, preferences);
      return;
    }
    if (action === "copy id") {
      await vscode.env.clipboard.writeText(session.id);
      void vscode.window.showInformationMessage("Pi session ID copied.");
      return;
    }
    if (action === "copy path") {
      await vscode.env.clipboard.writeText(session.file);
      void vscode.window.showInformationMessage("Pi session path copied.");
      return;
    }
    if (action === "open file") {
      await vscode.window.showTextDocument(vscode.Uri.file(session.file), { preview: true });
      return;
    }
    if (action === "export html") {
      await this.exportSession(session);
      return;
    }
    if (action === "resume") {
      await this.switchTo(session.file);
      return;
    }
    if (action === "rename") {
      const name = await vscode.window.showInputBox({
        title: "Rename Pi Session",
        value: session.name ?? "",
        prompt: "Leave blank to clear the custom name",
      });
      if (name === undefined) return;
      if (session.file === this.dependencies.state().sessionFile) {
        await this.dependencies.client()?.request({ type: "set_session_name", name });
      } else {
        await this.renameInactive(session, name);
      }
      await this.dependencies.refreshState();
      void vscode.window.showInformationMessage("Pi session renamed.");
      return;
    }
    if (action === "clone" || action === "fork") {
      await this.switchTo(session.file);
      if (action === "clone") {
        await this.dependencies.client()?.request({ type: "clone" });
      } else {
        const response = await this.dependencies.client()?.request({ type: "get_fork_messages" });
        const messages = arrayValue(recordValue(response?.data).messages).map(recordValue);
        const selected = await vscode.window.showQuickPick(
          messages.map((message) => ({
            label: truncateContext(String(message.text ?? ""), 120),
            entryId: String(message.entryId ?? ""),
          })),
          { title: "Fork Pi Session", placeHolder: "Choose the user message to branch from" },
        );
        if (!selected) return;
        await this.dependencies.client()?.request({ type: "fork", entryId: selected.entryId });
      }
      this.dependencies.post({ type: "clear" });
      await this.dependencies.refresh();
      return;
    }
    if (session.file === this.dependencies.state().sessionFile) {
      void vscode.window.showWarningMessage("Switch away from the active Pi session before archiving or deleting it.");
      return;
    }
    if (action === "archive") {
      await archiveSession(session.file);
      void vscode.window.showInformationMessage("Pi session archived.");
      return;
    }
    if (action === "restore") {
      await restoreArchivedSession(session.file);
      void vscode.window.showInformationMessage("Pi session restored.");
      return;
    }
    if (action === "delete") {
      const confirmed = await vscode.window.showWarningMessage(
        `Delete “${session.name || firstLine(session.preview)}”?`,
        { modal: true, detail: "VS Code will use the operating system trash when available." },
        "Move to Trash",
      );
      if (confirmed === "Move to Trash") {
        await vscode.workspace.fs.delete(vscode.Uri.file(session.file), { recursive: false, useTrash: true });
      }
    }
  }

  private async switchTo(file: string): Promise<void> {
    const client = this.dependencies.client();
    if (!client?.running || file === this.dependencies.state().sessionFile) return;
    if (this.dependencies.state().isStreaming) {
      const stop = await vscode.window.showWarningMessage(
        "Stop the active Pi task and switch sessions?",
        { modal: true },
        "Stop and Switch",
      );
      if (stop !== "Stop and Switch") return;
      await this.dependencies.abort();
    }
    const response = await client.request({ type: "switch_session", sessionPath: file });
    if (recordValue(response.data).cancelled === true) return;
    this.dependencies.post({ type: "clear" });
    await this.dependencies.refresh();
  }

  private async renameInactive(session: SessionSummary, name: string): Promise<void> {
    const folder = this.dependencies.workspaceFolder();
    if (!folder) return;
    const configured = vscode.workspace.getConfiguration("pide", folder.uri).get<string>("executablePath", "pi");
    const executable = await resolvePiExecutable({ configured });
    const helper = new PiRpcClient((line) => this.dependencies.output.appendLine(`[Pi session helper] ${line}`));
    helper.start({
      executable,
      cwd: session.cwd,
      args: ["--no-extensions", "--no-skills", "--no-prompt-templates"],
      sessionFile: session.file,
      approveWorkspace: false,
    });
    try {
      await helper.request({ type: "get_state" });
      await helper.request({ type: "set_session_name", name });
    } finally {
      await helper.stop();
    }
  }

  private async pickSessionAction(
    sessions: SessionSummary[],
    preferences: SessionPreferences,
    workspaceUri: vscode.Uri,
  ): Promise<{ session: SessionSummary; action: string } | undefined> {
    interface SessionItem extends vscode.QuickPickItem { session: SessionSummary }
    const buttons = {
      rename: { iconPath: new vscode.ThemeIcon("edit"), tooltip: "Rename" },
      fork: { iconPath: new vscode.ThemeIcon("git-branch"), tooltip: "Fork" },
      clone: { iconPath: new vscode.ThemeIcon("copy"), tooltip: "Clone" },
      archive: { iconPath: new vscode.ThemeIcon("archive"), tooltip: "Archive" },
      restore: { iconPath: new vscode.ThemeIcon("unarchive"), tooltip: "Restore" },
      pin: { iconPath: new vscode.ThemeIcon("pin"), tooltip: "Pin" },
      favorite: { iconPath: new vscode.ThemeIcon("star-full"), tooltip: "Favorite" },
      copyId: { iconPath: new vscode.ThemeIcon("key"), tooltip: "Copy ID" },
      copyPath: { iconPath: new vscode.ThemeIcon("copy"), tooltip: "Copy Path" },
      openFile: { iconPath: new vscode.ThemeIcon("go-to-file"), tooltip: "Open File" },
      exportHtml: { iconPath: new vscode.ThemeIcon("export"), tooltip: "Export HTML" },
      delete: { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Delete" },
    } satisfies Record<string, vscode.QuickInputButton>;
    const picker = vscode.window.createQuickPick<SessionItem>();
    picker.title = "Pi Session Library";
    picker.placeholder = "Search names, prompts, models, or session IDs";
    picker.buttons = [{ iconPath: new vscode.ThemeIcon("list-ordered"), tooltip: "Change session sort" }];
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    const buildItems = (query = ""): SessionItem[] => {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      return sessions.filter((session) => {
        if (!terms.length) return true;
        const haystack = `${session.name ?? ""}\n${session.id}\n${session.model ?? ""}\n${session.searchText}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      }).sort((a, b) => compareSessions(a, b, preferences)).map((session) => ({
        label: `${preferences.pinned.includes(session.file) ? "$(pin) " : ""}${preferences.favorites.includes(session.file) ? "$(star-full) " : ""}${session.name || firstLine(session.preview) || `Pi session ${shortId(session.id)}`}`,
        description: [
          session.file === this.dependencies.state().sessionFile
            ? "$(circle-filled) Current"
            : session.archived ? "Archived" : relativeTime(session.updatedAt),
          session.model,
        ].filter(Boolean).join(" · "),
        detail: `${session.preview.replace(/\n/g, " ")}  —  ${session.messageCount} messages · ${formatTokens(session.tokens)} tokens · $${session.cost.toFixed(4)}`,
        buttons: [buttons.pin, buttons.favorite, buttons.rename, buttons.fork, buttons.clone, buttons.copyId, buttons.copyPath, buttons.openFile, buttons.exportHtml, session.archived ? buttons.restore : buttons.archive, buttons.delete],
        alwaysShow: true,
        session,
      }));
    };
    picker.value = this.dependencies.context.workspaceState.get<string>(this.sessionFilterStorageKey(workspaceUri), "");
    picker.items = buildItems(picker.value);
    picker.onDidChangeValue((value) => {
      void this.dependencies.context.workspaceState.update(this.sessionFilterStorageKey(workspaceUri), value);
      picker.items = buildItems(value);
    });

    return await new Promise((resolvePromise) => {
      let settled = false;
      const finish = (value?: { session: SessionSummary; action: string }) => {
        if (settled) return;
        settled = true;
        picker.hide();
        picker.dispose();
        resolvePromise(value);
      };
      picker.onDidAccept(() => {
        const item = picker.selectedItems[0];
        if (item) finish({ session: item.session, action: "resume" });
      });
      picker.onDidTriggerItemButton(({ item, button }) => {
        finish({ session: item.session, action: button.tooltip?.toLowerCase() ?? "resume" });
      });
      picker.onDidTriggerButton(async () => {
        const selected = await vscode.window.showQuickPick([
          { label: "Most recent", value: "recent" },
          { label: "Name", value: "name" },
          { label: "Cost", value: "cost" },
        ], { title: "Sort Pi sessions" });
        if (!selected) return;
        preferences.sort = selected.value as SessionSort;
        await this.saveSessionPreferences(workspaceUri, preferences);
        picker.items = buildItems(picker.value);
      });
      picker.onDidHide(() => finish());
      picker.show();
    });
  }

  private async exportSession(session: SessionSummary): Promise<void> {
    const destination = await vscode.window.showSaveDialog({
      title: "Export Pi session to HTML",
      defaultUri: vscode.Uri.file(`${session.file.replace(/\.jsonl$/i, "")}.html`),
      filters: { HTML: ["html"] },
    });
    if (!destination) return;
    const active = session.file === this.dependencies.state().sessionFile ? this.dependencies.client() : undefined;
    if (active?.running) {
      await active.request({ type: "export_html", outputPath: destination.fsPath }, 120_000);
    } else {
      const configured = vscode.workspace.getConfiguration("pide").get<string>("executablePath", "pi");
      const executable = await resolvePiExecutable({ configured });
      await execFileAsync(executable, ["--export", session.file, destination.fsPath], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    }
    void vscode.window.showInformationMessage(`Exported ${basename(destination.fsPath)}.`);
  }

  private sessionPreferences(uri: vscode.Uri): SessionPreferences {
    const value = this.dependencies.context.workspaceState.get<Partial<SessionPreferences>>(this.sessionPreferencesStorageKey(uri), {});
    return {
      pinned: Array.isArray(value.pinned) ? value.pinned.filter((path): path is string => typeof path === "string") : [],
      favorites: Array.isArray(value.favorites) ? value.favorites.filter((path): path is string => typeof path === "string") : [],
      sort: value.sort === "name" || value.sort === "cost" ? value.sort : "recent",
    };
  }

  private async saveSessionPreferences(uri: vscode.Uri, preferences: SessionPreferences): Promise<void> {
    await this.dependencies.context.workspaceState.update(this.sessionPreferencesStorageKey(uri), preferences);
  }

  private sessionStorageKey(uri: vscode.Uri): string {
    return `pide.sessionFile:${uri.toString()}`;
  }

  private sessionsStorageKey(uri: vscode.Uri): string {
    return `pide.sessions:${uri.toString()}`;
  }

  private sessionPreferencesStorageKey(uri: vscode.Uri): string {
    return `pide.sessionPreferences:${uri.toString()}`;
  }

  private sessionFilterStorageKey(uri: vscode.Uri): string {
    return `pide.sessionFilter:${uri.toString()}`;
  }
}

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function shortId(id: string | undefined): string {
  return id ? id.slice(0, 8) : "unknown";
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
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

function toggle(items: string[], value: string): string[] {
  return items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
}

function compareSessions(a: SessionSummary, b: SessionSummary, preferences: SessionPreferences): number {
  const pin = Number(preferences.pinned.includes(b.file)) - Number(preferences.pinned.includes(a.file));
  if (pin) return pin;
  const favorite = Number(preferences.favorites.includes(b.file)) - Number(preferences.favorites.includes(a.file));
  if (favorite) return favorite;
  if (preferences.sort === "name") return (a.name || a.preview).localeCompare(b.name || b.preview);
  if (preferences.sort === "cost") return b.cost - a.cost || b.updatedAt - a.updatedAt;
  return b.updatedAt - a.updatedAt;
}
