import * as vscode from "vscode";
import type { PiRpcClient, RpcRecord } from "../piRpcClient";
import type { McpController } from "./mcpController";
import type { VscodeContextController } from "./vscodeContextController";

const CONTEXT_REQUEST_TITLE = "__PIDE_VSCODE_CONTEXT__";

export class ExtensionUiBridge {
  private readonly pending = new Map<string, (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void>();

  constructor(
    private readonly client: () => PiRpcClient | undefined,
    private readonly post: (message: Record<string, unknown>) => void,
    private readonly mcp: McpController,
    private readonly vscodeContext: VscodeContextController,
  ) {}

  async handle(request: RpcRecord): Promise<void> {
    const client = this.client();
    const id = request.id;
    if (!client || typeof id !== "string") return;
    const method = String(request.method ?? "");

    if (["select", "confirm", "input", "editor"].includes(method)) {
      const response = await this.inlineOrNative(request, method as "select" | "confirm" | "input" | "editor");
      client.send({ type: "extension_ui_response", id, ...response });
      return;
    }
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
    if (method === "input" && request.title === CONTEXT_REQUEST_TITLE) {
      const value = await this.vscodeContext.request(stringValue(request.placeholder));
      client.send({ type: "extension_ui_response", id, value });
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

  respond(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    const resolve = this.pending.get(id);
    this.pending.delete(id);
    resolve?.(response);
  }

  private async inlineOrNative(request: RpcRecord, method: "select" | "confirm" | "input" | "editor"): Promise<{ value?: string; confirmed?: boolean; cancelled?: boolean }> {
    if (method === "editor" || method === "input" || method === "select" || method === "confirm") {
      const id = String(request.id);
      const inline = new Promise<{ value?: string; confirmed?: boolean; cancelled?: boolean }>((resolve) => this.pending.set(id, resolve));
      this.post({ type: "extensionUiRequest", id, method, title: String(request.title ?? "Pi needs input"), message: stringValue(request.message), placeholder: stringValue(request.placeholder), prefill: stringValue(request.prefill), options: arrayValue(request.options).map(String).slice(0, 20) });
      const timeout = typeof request.timeout === "number" ? request.timeout : 120_000;
      return await Promise.race([inline, new Promise<{ cancelled: true }>((resolve) => setTimeout(() => { this.pending.delete(id); resolve({ cancelled: true }); }, Math.min(timeout, 120_000))) ]);
    }
    return { cancelled: true };
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
