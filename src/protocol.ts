import type { ChangeSet } from "./changeReview";
import type { AgentRole, AgentRunSnapshot } from "./controllers/agentLabController";
export type { AgentRole, AgentRunSnapshot } from "./controllers/agentLabController";

export interface PiModelState {
  id?: string;
  name?: string;
  provider?: string;
}

export interface PiState {
  model?: PiModelState | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  isRetrying?: boolean;
  autoCompactionEnabled?: boolean;
  autoRetryEnabled?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
}

export interface SessionTabState {
  id: string;
  title: string;
  status: string;
  unread?: boolean;
  active?: boolean;
}

export interface SessionStats {
  tokens?: number;
  cost?: number;
  contextUsage?: {
    tokens?: number | null;
    contextWindow?: number;
    percent?: number | null;
  };
}

export interface NormalizedMessage {
  role: string;
  text: string;
  thinking?: string;
  toolName?: string;
  isError?: boolean;
}

export interface PiCommandInfo {
  name: string;
  description?: string;
  source?: string;
}

export interface ContextCompletionItem {
  label: string;
  description: string;
  insertText: string;
  kind: "context" | "file";
}

export interface McpServerSnapshot {
  name: string;
  status: string;
  toolCount?: number;
  resourceCount?: number;
  disabled?: boolean;
}

export interface McpStatusSnapshot {
  servers: McpServerSnapshot[];
  totalTools?: number;
  totalResources?: number;
  connectedCount?: number;
  disabledCount?: number;
}

export type RuntimeHealthStatus = "checking" | "ready" | "missing" | "incompatible" | "untrusted" | "no-workspace" | "error";

export interface RuntimeHealth {
  status: RuntimeHealthStatus;
  executable?: string;
  version?: string;
  message: string;
  capabilities?: {
    rpc: boolean;
    session: boolean;
    approve: boolean;
    extensions: boolean;
  };
}

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "newSession" }
  | { type: "openSession" }
  | { type: "restart" }
  | { type: "pickModel" }
  | { type: "pickThinking" }
  | { type: "contextSearch"; query: string; requestId: string }
  | { type: "copyText"; text: string }
  | { type: "insertText"; text: string }
  | { type: "openLink"; href: string }
  | { type: "reviewChanges" }
  | { type: "openDiff"; path: string }
  | { type: "acceptChange"; path: string }
  | { type: "revertChange"; path: string }
  | { type: "mcpAction"; action: string; server?: string; command?: string }
  | { type: "openMcpConfig" }
  | { type: "showOutput" }
  | { type: "manageTrust" }
  | { type: "openRuntimeSettings" }
  | { type: "retryRuntime" }
  | { type: "compactSession" }
  | { type: "reloadSession" }
  | { type: "openResources" }
  | { type: "openAgentLab" }
  | { type: "refreshAgentLab" }
  | { type: "runAgentLab"; roleIds: string[]; task: string }
  | { type: "stopAgentLab"; runId?: string }
  | { type: "retryAgentLab"; runId: string }
  | { type: "activateTab"; id: string }
  | { type: "closeTab"; id: string }
  | { type: "extensionUiResponse"; id: string; value?: string; confirmed?: boolean; cancelled?: boolean };

export type HostToWebviewMessage =
  | { type: "connection"; status: string; message: string }
  | { type: "runtimeHealth"; health: RuntimeHealth }
  | { type: "history"; messages: NormalizedMessage[] }
  | { type: "commands"; commands: PiCommandInfo[] }
  | { type: "contextResults"; requestId: string; items: ContextCompletionItem[] }
  | ({ type: "state" } & PiState)
  | { type: "sessionStats"; stats: SessionStats }
  | { type: "sessionTabs"; tabs: SessionTabState[] }
  | { type: "agentLab"; roles: AgentRole[]; runs: AgentRunSnapshot[]; maxConcurrent: number }
  | { type: "clear" }
  | { type: "userPrompt"; text: string }
  | { type: "textDelta"; delta: string }
  | { type: "thinkingDelta"; delta: string }
  | { type: "messageEnd"; role: unknown }
  | { type: "toolStart"; id: unknown; name: unknown; args: unknown }
  | { type: "toolUpdate"; id: unknown; result: unknown }
  | { type: "toolEnd"; id: unknown; result: unknown; isError: boolean }
  | { type: "busy"; value: boolean }
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | { type: "extensionStatus"; key: unknown; text: unknown }
  | { type: "widget"; key: unknown; lines: string[] }
  | { type: "extensionUiRequest"; id: string; method: "select" | "confirm" | "input" | "editor"; title: string; message?: string; placeholder?: string; prefill?: string; options?: string[] }
  | { type: "prefill"; text: unknown }
  | { type: "changeSet"; changeSet: ChangeSet }
  | { type: "showChanges"; changeSet: ChangeSet }
  | { type: "hideChanges" }
  | { type: "mcpStatus"; snapshot: McpStatusSnapshot }
  | { type: "mcpPrompts"; prompts: PiCommandInfo[] }
  | { type: "queue"; steering: unknown; followUp: unknown };

export function parseWebviewMessage(value: unknown): WebviewToHostMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const noData = new Set([
    "ready", "abort", "newSession", "openSession", "restart", "pickModel", "pickThinking",
    "reviewChanges", "openMcpConfig", "showOutput", "manageTrust", "openRuntimeSettings", "retryRuntime",
    "compactSession", "reloadSession", "openResources", "openAgentLab", "refreshAgentLab",
  ]);
  if (noData.has(value.type)) return { type: value.type } as WebviewToHostMessage;
  if (["prompt", "copyText", "insertText"].includes(value.type)) {
    const text = boundedString(value.text, 2 * 1024 * 1024);
    return text === undefined ? undefined : { type: value.type, text } as WebviewToHostMessage;
  }
  if (value.type === "openLink") {
    const href = boundedString(value.href, 8 * 1024);
    return href === undefined ? undefined : { type: value.type, href };
  }
  if (["openDiff", "acceptChange", "revertChange"].includes(value.type)) {
    const path = boundedString(value.path, 32 * 1024);
    return path === undefined ? undefined : { type: value.type, path } as WebviewToHostMessage;
  }
  if (value.type === "contextSearch") {
    const query = boundedString(value.query, 4 * 1024);
    const requestId = boundedString(value.requestId, 256);
    return query === undefined || requestId === undefined
      ? undefined
      : { type: value.type, query, requestId };
  }
  if (value.type === "runAgentLab") {
    const task = boundedString(value.task, 64 * 1024);
    const roleIds = Array.isArray(value.roleIds) ? value.roleIds.filter((item): item is string => typeof item === "string" && item.length <= 512).slice(0, 16) : undefined;
    return task === undefined || roleIds === undefined ? undefined : { type: value.type, roleIds, task };
  }
  if (["stopAgentLab", "retryAgentLab"].includes(value.type)) {
    const runId = optionalBoundedString(value.runId, 512);
    return runId === undefined ? undefined : { type: value.type, runId: runId || undefined } as WebviewToHostMessage;
  }
  if (["activateTab", "closeTab"].includes(value.type)) {
    const id = boundedString(value.id, 4096);
    return id === undefined ? undefined : { type: value.type, id } as WebviewToHostMessage;
  }
  if (value.type === "extensionUiResponse") {
    const id = boundedString(value.id, 256);
    const response = optionalBoundedString(value.value, 2 * 1024 * 1024);
    return id === undefined || response === undefined || (value.confirmed !== undefined && typeof value.confirmed !== "boolean") || (value.cancelled !== undefined && typeof value.cancelled !== "boolean")
      ? undefined : { type: value.type, id, value: response || undefined, confirmed: value.confirmed as boolean | undefined, cancelled: value.cancelled as boolean | undefined };
  }
  if (value.type === "mcpAction") {
    const action = boundedString(value.action, 64);
    const server = optionalBoundedString(value.server, 512);
    const command = optionalBoundedString(value.command, 512);
    if (!action || server === undefined || command === undefined) return undefined;
    return { type: value.type, action, server, command };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function optionalBoundedString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return "";
  return boundedString(value, maxLength);
}
