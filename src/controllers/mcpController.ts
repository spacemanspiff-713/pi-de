import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { PiCommandInfo, McpStatusSnapshot } from "../protocol";
import type { PiRpcClient } from "../piRpcClient";

const MCP_WIDGET_KEY = "pi-vscode:mcp-status";
const MCP_SENTINEL = "__PI_VSCODE_MCP_STATUS__";

export class McpController {
  private current?: McpStatusSnapshot;

  constructor(
    private readonly workspaceFolder: () => vscode.WorkspaceFolder | undefined,
    private readonly client: () => PiRpcClient | undefined,
    private readonly restart: () => Promise<void>,
    private readonly post: (message: Record<string, unknown>) => void,
    private readonly refreshCommands: () => Promise<void>,
  ) {}

  get status(): McpStatusSnapshot | undefined {
    return this.current;
  }

  postStatus(): void {
    if (this.current) this.post({ type: "mcpStatus", snapshot: this.current });
  }

  postPrompts(commands: PiCommandInfo[]): void {
    this.post({ type: "mcpPrompts", prompts: commands.filter((command) => command.name.startsWith("mcp__")) });
  }

  handleWidget(key: unknown, linesValue: unknown): boolean {
    if (key !== MCP_WIDGET_KEY) return false;
    const lines = Array.isArray(linesValue) ? linesValue.map(String) : [];
    if (!lines[0]?.startsWith(MCP_SENTINEL)) return true;
    try {
      const parsed = JSON.parse(lines[0].slice(MCP_SENTINEL.length)) as unknown;
      if (!isMcpSnapshot(parsed)) return true;
      this.current = parsed;
      this.postStatus();
      void this.refreshCommands().catch(() => undefined);
    } catch {
      // Malformed bridge snapshots are ignored and never reach the webview.
    }
    return true;
  }

  async action(action: string, server: string, command: string): Promise<void> {
    if (action === "prompt") {
      this.post({ type: "prefill", text: `/${command} ` });
      return;
    }
    if (action === "config") {
      await this.openConfig();
      return;
    }
    const client = this.client();
    if (!client?.running) return;
    if (action === "reconnect") {
      await client.request({ type: "prompt", message: `/mcp reconnect${server ? ` ${server}` : ""}` }, 90_000);
      return;
    }
    if (action === "auth") {
      await client.request({ type: "prompt", message: `/mcp-auth ${server}` }, 180_000);
      return;
    }
    if (action === "logout") {
      await client.request({ type: "prompt", message: `/mcp logout ${server}` }, 90_000);
      return;
    }
    if (action === "enable" || action === "disable") {
      await client.request({ type: "prompt", message: `/mcp ${action} ${server}` }, 90_000);
      await this.restart();
    }
  }

  async openConfig(): Promise<void> {
    const folder = this.workspaceFolder();
    if (!folder) return;
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const candidates = [
      join(folder.uri.fsPath, ".mcp.json"),
      join(folder.uri.fsPath, ".pi", "mcp.json"),
      join(agentDir, "mcp.json"),
      join(homedir(), ".config", "mcp", "mcp.json"),
      join(homedir(), ".agents", "mcp.json"),
      join(homedir(), ".agents", "mcp", "mcp.json"),
    ].filter((path) => existsSync(path));
    if (!candidates.length) {
      const create = await vscode.window.showInformationMessage("No MCP configuration file was found.", "Create .mcp.json");
      if (create !== "Create .mcp.json") return;
      const uri = vscode.Uri.joinPath(folder.uri, ".mcp.json");
      await vscode.workspace.fs.writeFile(uri, Buffer.from('{\n  "mcpServers": {}\n}\n'));
      candidates.push(uri.fsPath);
    }
    const selected = candidates.length === 1
      ? candidates[0]
      : await vscode.window.showQuickPick(candidates, { title: "Open MCP Configuration" });
    if (!selected) return;
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(selected)));
  }
}

function isMcpSnapshot(value: unknown): value is McpStatusSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const servers = (value as Record<string, unknown>).servers;
  if (!Array.isArray(servers)) return false;
  return servers.every((server) => Boolean(server)
    && typeof server === "object"
    && !Array.isArray(server)
    && typeof (server as Record<string, unknown>).name === "string"
    && typeof (server as Record<string, unknown>).status === "string");
}
