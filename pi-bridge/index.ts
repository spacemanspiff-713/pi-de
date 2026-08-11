import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
const MCP_WIDGET_KEY = "pi-vscode:mcp-status";

/** Bridges Pi extension event-bus state into the RPC extension UI protocol. */
export default function piVsCodeBridge(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let latestSnapshot: unknown;

  const publish = (snapshot: unknown) => {
    latestSnapshot = snapshot;
    if (!context?.hasUI) return;
    context.ui.setWidget(MCP_WIDGET_KEY, [`__PI_VSCODE_MCP_STATUS__${JSON.stringify(snapshot)}`]);
  };

  pi.events.on(MCP_STATUS_EVENT, publish);
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    if (latestSnapshot !== undefined) publish(latestSnapshot);
  });
  pi.on("session_shutdown", () => {
    context = undefined;
  });
}
