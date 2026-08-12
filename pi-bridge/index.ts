import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
const MCP_WIDGET_KEY = "pide:mcp-status";
const CONTEXT_REQUEST_TITLE = "__PIDE_VSCODE_CONTEXT__";
type ContextAction = "selection" | "diagnostics" | "editors" | "symbols" | "definitions" | "references" | "hover";

/** Bridges Pi status plus deliberately read-only VS Code context into RPC mode. */
export default function piDeBridge(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let latestSnapshot: unknown;
  const requestContext = async (action: ContextAction, query = "") => {
    if (!context?.hasUI) return "VS Code context is unavailable outside the PiDE RPC session.";
    const response = await context.ui.input(CONTEXT_REQUEST_TITLE, JSON.stringify({ action, query }));
    return response || "No matching VS Code context is available.";
  };
  const publish = (snapshot: unknown) => {
    latestSnapshot = snapshot;
    if (context?.hasUI) context.ui.setWidget(MCP_WIDGET_KEY, [`__PIDE_MCP_STATUS__${JSON.stringify(snapshot)}`]);
  };

  pi.events.on(MCP_STATUS_EVENT, publish);
  pi.on("session_start", (_event, ctx) => { context = ctx; if (latestSnapshot !== undefined) publish(latestSnapshot); });
  pi.on("session_shutdown", () => { context = undefined; });

  pi.registerTool({
    name: "vscode_context",
    label: "VS Code Context",
    description: "Read bounded context from the active PiDE VS Code workspace. Read-only: never edits files or executes commands.",
    parameters: Type.Object({
      action: Type.Union(["selection", "diagnostics", "editors", "symbols", "definitions", "references", "hover"].map((value) => Type.Literal(value))),
      query: Type.Optional(Type.String({ maxLength: 512 })),
    }),
    async execute(_toolCallId, params) {
      const text = await requestContext(params.action, params.query ?? "");
      return { content: [{ type: "text", text }], details: { readOnly: true, action: params.action } };
    },
  });

  for (const [name, action] of [["vscode-selection", "selection"], ["vscode-diagnostics", "diagnostics"], ["vscode-symbols", "symbols"], ["vscode-references", "references"]] as const) {
    pi.registerCommand(name, { description: `Show bounded VS Code ${action} context`, handler: async (args, ctx) => ctx.ui.notify(await requestContext(action, args), "info") });
  }
}
