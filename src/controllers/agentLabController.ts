import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { RpcRecord } from "../piRpcClient";
import { PiRuntime, type PiRuntimeEvent } from "../runtime/piRuntime";

export interface AgentRole {
  id: string;
  name: string;
  description: string;
  model?: string;
  tools: string[];
  invocation: "manual" | "automatic";
  source: "builtin" | "user" | "project";
  prompt: string;
}

export interface AgentRunSnapshot {
  id: string;
  roleId: string;
  roleName: string;
  status: "queued" | "starting" | "running" | "succeeded" | "failed" | "cancelled";
  progress: string;
  result?: string;
  error?: string;
  model?: string;
  tokens?: number;
  cost?: number;
  durationMs?: number;
  startedAt?: number;
  finishedAt?: number;
  toolEvents: Array<{ tool: string; status: string }>;
}

interface QueueItem {
  run: AgentRunSnapshot;
  role: AgentRole;
  task: string;
}

const READ_ONLY_TOOLS = ["read", "codebase_search", "filesystem_map", "git_change_map", "test_failure_summarizer", "math_tool", "web_fetch", "brave_search", "honcho_search", "honcho_context", "honcho_chat"];
const FORBIDDEN_TOOLS = new Set(["edit", "write", "bash", "mcpScript", "shopify_dev_mcp_learn_shopify_api", "mcp"]);

export class AgentLabController implements vscode.Disposable {
  private readonly runs = new Map<string, { snapshot: AgentRunSnapshot; runtime?: PiRuntime; cleanup?: string; unsubscribe?: () => void }>();
  private queue: QueueItem[] = [];
  private active = 0;
  private rolesCache?: AgentRole[];
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly workspaceFolder: () => vscode.WorkspaceFolder | undefined,
    private readonly post: (message: Record<string, unknown>) => void,
  ) {}

  async open(): Promise<void> {
    this.post({ type: "agentLab", roles: await this.discoverRoles(), runs: this.snapshots(), maxConcurrent: this.maxConcurrent() });
  }

  async refresh(): Promise<void> {
    this.rolesCache = undefined;
    await this.open();
  }

  async run(roleIds: string[], task: string): Promise<void> {
    const roles = await this.discoverRoles();
    const selected = roles.filter((role) => roleIds.includes(role.id));
    if (!task.trim() || !selected.length) return;
    const budget = vscode.workspace.getConfiguration("pide").get<number>("agentLabTokenBudget", 12_000);
    for (const role of selected) {
      const run: AgentRunSnapshot = {
        id: randomUUID(), roleId: role.id, roleName: role.name, status: "queued", progress: `Queued with ${budget} token budget`, toolEvents: [],
      };
      this.runs.set(run.id, { snapshot: run });
      this.queue.push({ run, role, task: task.trim().slice(0, 24_000) });
    }
    this.publish();
    void this.pump();
  }

  async stop(runId?: string): Promise<void> {
    if (!runId) {
      this.queue = [];
      await Promise.all(Array.from(this.runs.keys()).map((id) => this.stop(id)));
      this.publish();
      return;
    }
    this.queue = this.queue.filter((item) => item.run.id !== runId);
    const entry = this.runs.get(runId);
    if (!entry) return;
    if (["succeeded", "failed", "cancelled"].includes(entry.snapshot.status)) return;
    entry.snapshot.status = "cancelled";
    entry.snapshot.finishedAt = Date.now();
    entry.snapshot.durationMs = entry.snapshot.startedAt ? entry.snapshot.finishedAt - entry.snapshot.startedAt : undefined;
    entry.snapshot.progress = "Cancelled";
    await entry.runtime?.stop().catch(() => undefined);
    await this.cleanup(entry);
    this.publish();
  }

  async retry(runId: string): Promise<void> {
    const old = this.runs.get(runId)?.snapshot;
    if (!old) return;
    const roles = await this.discoverRoles();
    const role = roles.find((item) => item.id === old.roleId);
    if (!role) return;
    await this.run([role.id], old.result ? `Retry this Agent Lab task. Previous result for context:\n\n${old.result}` : "Retry the previous Agent Lab task from the active PiDE context.");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  async discoverRoles(): Promise<AgentRole[]> {
    if (this.rolesCache) return this.rolesCache;
    const folder = this.workspaceFolder();
    const discovered = [
      ...builtinRoles(),
      ...await readRoleDir(join(homedir(), ".pi", "agent", "agents"), "user"),
      ...await readRoleDir(folder ? join(folder.uri.fsPath, ".pi", "agents") : "", "project"),
    ];
    const byId = new Map<string, AgentRole>();
    for (const role of discovered) byId.set(role.id, role);
    this.rolesCache = Array.from(byId.values());
    return this.rolesCache;
  }

  private async pump(): Promise<void> {
    if (this.disposed) return;
    const max = this.maxConcurrent();
    while (this.active < max && this.queue.length) {
      const item = this.queue.shift();
      if (!item) break;
      this.active += 1;
      void this.execute(item).finally(() => {
        this.active -= 1;
        void this.pump();
      });
    }
  }

  private async execute(item: QueueItem): Promise<void> {
    const entry = this.runs.get(item.run.id);
    if (!entry) return;
    const startedAt = Date.now();
    item.run.status = "starting";
    item.run.startedAt = startedAt;
    item.run.progress = "Starting isolated read-only Pi process…";
    this.publish();

    const folder = this.workspaceFolder();
    if (!folder || !vscode.workspace.isTrusted) return this.fail(item.run, "Agent Lab requires a trusted filesystem workspace.");
    const config = vscode.workspace.getConfiguration("pide", folder.uri);
    const cwd = await mkdtemp(join(tmpdir(), "pide-agent-lab-"));
    entry.cleanup = cwd;
    const runtime = new PiRuntime((line) => this.output.appendLine(`[Agent Lab:${item.role.name}] ${line}`));
    entry.runtime = runtime;
    let result = "";
    let abortedForTool = false;
    entry.unsubscribe = runtime.onEvent((event) => {
      if (event.type === "record") {
        const delta = extractTextDelta(event.record);
        if (delta) {
          result = `${result}${delta}`.slice(-64_000);
          item.run.result = result;
        }
        const tool = toolName(event.record);
        if (tool) {
          item.run.toolEvents.push({ tool, status: String(event.record.type ?? "tool") });
          item.run.toolEvents = item.run.toolEvents.slice(-40);
          if (FORBIDDEN_TOOLS.has(tool)) {
            abortedForTool = true;
            item.run.status = "failed";
            item.run.error = `Forbidden tool attempted: ${tool}`;
            item.run.progress = "Aborting forbidden write-capable tool.";
            void runtime.stop();
          }
        }
        if (event.record.type === "agent_start") {
          item.run.status = "running";
          item.run.progress = "Running";
        }
        if (event.record.type === "agent_settled") void this.finish(item.run, result || "No textual result returned.");
        this.publish();
      } else if (event.type === "exit" && !event.expected && item.run.status !== "succeeded") {
        this.fail(item.run, abortedForTool ? item.run.error ?? "Forbidden tool attempted" : `Subagent exited with code ${String(event.code)}`);
      }
    });

    const bridgePath = vscode.Uri.joinPath(this.context.extensionUri, "pi-bridge", "index.ts").fsPath;
    const started = await runtime.start({
      configuredExecutable: config.get<string>("executablePath", "pi").trim() || "pi",
      cwd,
      args: [...config.get<string[]>("extraArgs", []), "--extension", bridgePath],
      approveWorkspace: false,
    });
    if (!started) return this.fail(item.run, runtime.health?.message ?? "Could not start Pi.");
    item.run.progress = "Prompt sent";
    this.publish();
    const prompt = agentPrompt(item.role, item.task, folder.uri.fsPath, config.get<number>("agentLabTokenBudget", 12_000));
    try {
      await runtime.client?.request({ type: "prompt", message: prompt }, 60_000);
    } catch (error) {
      this.fail(item.run, error instanceof Error ? error.message : String(error));
    }
  }

  private async finish(run: AgentRunSnapshot, result: string): Promise<void> {
    const entry = this.runs.get(run.id);
    if (!entry || ["failed", "cancelled"].includes(run.status)) return;
    run.status = "succeeded";
    run.result = result.slice(0, 64_000);
    run.progress = "Complete";
    run.finishedAt = Date.now();
    run.durationMs = run.startedAt ? run.finishedAt - run.startedAt : undefined;
    await entry.runtime?.stop().catch(() => undefined);
    await this.cleanup(entry);
    this.publish();
  }

  private fail(run: AgentRunSnapshot, error: string): void {
    const entry = this.runs.get(run.id);
    run.status = "failed";
    run.error = error;
    run.progress = "Failed";
    run.finishedAt = Date.now();
    run.durationMs = run.startedAt ? run.finishedAt - run.startedAt : undefined;
    void entry?.runtime?.stop();
    void (entry ? this.cleanup(entry) : Promise.resolve());
    this.publish();
  }

  private async cleanup(entry: { cleanup?: string; unsubscribe?: () => void }): Promise<void> {
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
    if (entry.cleanup) await rm(entry.cleanup, { recursive: true, force: true }).catch(() => undefined);
    entry.cleanup = undefined;
  }

  private maxConcurrent(): number {
    const value = vscode.workspace.getConfiguration("pide").get<number>("agentLabMaxConcurrent", 4);
    return Math.max(1, Math.min(8, Math.floor(value || 4)));
  }

  private snapshots(): AgentRunSnapshot[] {
    return Array.from(this.runs.values()).map((entry) => entry.snapshot).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  private publish(): void {
    void this.open();
  }
}

function builtinRoles(): AgentRole[] {
  const base = { tools: READ_ONLY_TOOLS, invocation: "manual" as const, source: "builtin" as const };
  return [
    { ...base, id: "architect", name: "Architect", description: "Designs approaches, boundaries, risks, and implementation plans.", prompt: "Focus on architecture, sequencing, interfaces, and risk tradeoffs." },
    { ...base, id: "explorer", name: "Explorer", description: "Maps unfamiliar code and finds likely edit/test targets.", prompt: "Explore structure and identify relevant files, symbols, and dependencies." },
    { ...base, id: "reviewer", name: "Reviewer", description: "Reviews changes for correctness, maintainability, and regressions.", prompt: "Review critically. Prioritize concrete issues and verification gaps." },
    { ...base, id: "tester", name: "Tester", description: "Plans validation and diagnoses failures without modifying files.", prompt: "Focus on tests, reproduction, logs, and minimal validation commands." },
    { ...base, id: "researcher", name: "Researcher", description: "Gathers bounded external or documentation context.", prompt: "Research only what is necessary. Cite compact findings and uncertainty." },
    { ...base, id: "security", name: "Security", description: "Looks for security, privacy, trust, and supply-chain risks.", prompt: "Focus on concrete abuse cases, secrets, auth boundaries, and mitigations." },
    { ...base, id: "documentation", name: "Documentation", description: "Improves explanations, docs structure, and user-facing clarity.", prompt: "Focus on concise documentation gaps and suggested wording." },
  ];
}

async function readRoleDir(dir: string, source: "user" | "project"): Promise<AgentRole[]> {
  if (!dir) return [];
  try {
    const files = (await readdir(dir)).filter((file) => file.endsWith(".md"));
    return (await Promise.all(files.map(async (file) => parseRole(join(dir, file), source)))).filter((role): role is AgentRole => Boolean(role));
  } catch { return []; }
}

async function parseRole(path: string, source: "user" | "project"): Promise<AgentRole | undefined> {
  const raw = await readFile(path, "utf8").catch(() => "");
  if (!raw.trim()) return undefined;
  const { frontmatter, body } = splitFrontmatter(raw);
  const name = frontmatter.name || basename(path, ".md");
  return {
    id: `${source}:${slug(name)}`,
    name,
    description: frontmatter.description || body.split(/\r?\n/).find((line) => line.trim())?.slice(0, 160) || "Custom read-only Agent Lab role",
    model: frontmatter.model,
    tools: (frontmatter.tools ? frontmatter.tools.split(/[,\s]+/).filter(Boolean) : READ_ONLY_TOOLS).filter((tool) => !FORBIDDEN_TOOLS.has(tool)),
    invocation: frontmatter.invocation === "automatic" ? "automatic" : "manual",
    source,
    prompt: body.trim().slice(0, 8_000),
  };
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of raw.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (match) fm[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return { frontmatter: fm, body: raw.slice(end + 5) };
}

function agentPrompt(role: AgentRole, task: string, workspacePath: string, budget: number): string {
  return `You are a PiDE Agent Lab subagent named ${role.name}.\n\nREAD-ONLY SAFETY CONTRACT:\n- Do not modify files, do not write files, do not run shell commands that mutate state, and do not use edit/write/bash.\n- Allowed tool intent: ${role.tools.join(", ")}.\n- Work from an isolated temporary process. Treat workspace path as read-only context: ${workspacePath}.\n- Keep the response bounded. Do not write noisy transcripts to Honcho memory.\n- Token budget: ${budget}. Stop early if the budget is at risk.\n\nRole instructions:\n${role.prompt}\n\nTask from parent PiDE session:\n${task}\n\nReturn: status, key findings, evidence/file references, risks, and recommended next steps. Do not apply changes.`;
}

function extractTextDelta(record: RpcRecord): string {
  if (record.type !== "message_update") return "";
  const event = record.assistantMessageEvent as Record<string, unknown> | undefined;
  return event?.type === "text_delta" && typeof event.delta === "string" ? event.delta : "";
}

function toolName(record: RpcRecord): string | undefined {
  if (record.type !== "tool_execution_start") return undefined;
  return typeof record.toolName === "string" ? record.toolName : undefined;
}

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent"; }
