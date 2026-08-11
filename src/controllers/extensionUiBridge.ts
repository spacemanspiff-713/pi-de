import * as vscode from "vscode";
import type { PiRpcClient, RpcRecord } from "../piRpcClient";
import type { McpController } from "./mcpController";

export class ExtensionUiBridge {
  constructor(
    private readonly client: () => PiRpcClient | undefined,
    private readonly post: (message: Record<string, unknown>) => void,
    private readonly mcp: McpController,
  ) {}

  async handle(request: RpcRecord): Promise<void> {
    const client = this.client();
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
      const value = await vscode.window.showQuickPick(arrayValue(request.options).map(String), {
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
        prompt: stringValue(request.message),
        placeHolder: stringValue(request.placeholder),
        value: stringValue(request.prefill),
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
      if (this.mcp.handleWidget(request.widgetKey, request.widgetLines)) return;
      this.post({ type: "widget", key: request.widgetKey, lines: arrayValue(request.widgetLines).map(String) });
      return;
    }
    if (method === "set_editor_text") {
      this.post({ type: "prefill", text: request.text });
      return;
    }

    client.send({ type: "extension_ui_response", id, cancelled: true });
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
