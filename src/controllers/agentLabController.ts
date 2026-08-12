import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, basename, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { RpcRecord } from "../piRpcClient";
import { PiRuntime, type PiRuntimeEvent } from "../runtime/piRuntime";
import { agentAfterContent, agentBeforeContent, applyAgentPatch, captureAgentChanges, commitAgentWorktree, createAgentPatch, createAgentWorktree, mergeAgentBranch, removeAgentWorktree, validateAgentWorktree, worktreeExists, type AgentWorktree } from "./agentWorktreeManager";
import type { ChangedFile } from "../changeReview";
import { boundedToolArgs, extractAgentSources, toolResultText, type AgentSource } from "../agentArtifacts";
export type { AgentSource } from "../agentArtifacts";

export interface AgentRole {
  id: string;
  name: string;
  description: string;
  model?: string;
  tools: string[];
  invocation: "manual" | "automatic";
  source: "builtin" | "user" | "project";
  prompt: string;
  mode?: "read-only" | "worktree";
  skills?: string[];
  maxToolCalls?: number;
  maxDurationMs?: number;
  filePath?: string;
}

export interface AgentRunSnapshot {
  id: string;
  roleId: string;
  roleName: string;
  task?: string;
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
  toolEvents: Array<{ id?: string; tool: string; status: string; args?: Record<string, unknown>; result?: string; isError?: boolean }>;
  toolCounts: Record<string, number>;
  toolCallCount: number;
  maxToolCalls: number;
  maxDurationMs: number;
  lastTool?: string;
  sources?: AgentSource[];
  worktree?: { root: string; path: string; branch: string; baseCommit: string; baselineStatus: string; lifecycle: "active" | "complete" | "integrated" | "abandoned" | "cleaned"; createdAt: number };
  changes?: ChangedFile[];
  validation?: { ok: boolean; output: string };
  audit: string[];
}

interface QueueItem {
  run: AgentRunSnapshot;
  role: AgentRole;
  task: string;
}

const READ_ONLY_TOOLS = ["read", "codebase_search", "filesystem_map", "git_change_map", "test_failure_summarizer", "math_tool", "web_fetch", "brave_search", "honcho_search", "honcho_context", "honcho_chat"];
const FORBIDDEN_TOOLS = new Set(["edit", "write", "bash", "mcpScript", "shopify_dev_mcp_learn_shopify_api", "mcp"]);

export class AgentLabController implements vscode.Disposable {
  private readonly runs = new Map<string, { snapshot: AgentRunSnapshot; runtime?: PiRuntime; cleanup?: string; unsubscribe?: () => void; worktree?: AgentWorktree; timer?: NodeJS.Timeout }>();
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

  async restore(): Promise<void> {
    const stored = this.context.workspaceState.get<AgentRunSnapshot[]>("pide.agentLabRuns", []);
    for (const snapshot of stored) {
      snapshot.toolCounts ??= {};
      snapshot.toolCallCount ??= snapshot.toolEvents?.length ?? 0;
      snapshot.maxToolCalls ??= vscode.workspace.getConfiguration("pide").get<number>("agentLabMaxToolCalls", 24);
      snapshot.maxDurationMs ??= vscode.workspace.getConfiguration("pide").get<number>("agentLabMaxDurationMinutes", 5) * 60_000;
      if (!snapshot.worktree) continue;
      const worktree: AgentWorktree = { id: snapshot.id, ...snapshot.worktree };
      this.runs.set(snapshot.id, { snapshot, worktree });
    }
    await this.recoverAbandoned();
  }

  async refresh(): Promise<void> {
    this.rolesCache = undefined;
    await this.open();
  }

  async roleIds(): Promise<string[]> {
    return (await this.discoverRoles()).map((role) => role.id);
  }

  async run(roleIds: string[], task: string): Promise<void> {
    const roles = await this.discoverRoles();
    const selected = roles.filter((role) => roleIds.includes(role.id));
    if (!task.trim() || !selected.length) return;
    const budget = vscode.workspace.getConfiguration("pide").get<number>("agentLabTokenBudget", 12_000);
    for (const role of selected) {
      const maxToolCalls = role.maxToolCalls ?? vscode.workspace.getConfiguration("pide").get<number>("agentLabMaxToolCalls", 24);
      const maxDurationMs = role.maxDurationMs ?? vscode.workspace.getConfiguration("pide").get<number>("agentLabMaxDurationMinutes", 5) * 60_000;
      const run: AgentRunSnapshot = {
        id: randomUUID(), roleId: role.id, roleName: role.name, task: task.trim().slice(0, 24_000), status: "queued", progress: `Queued with ${budget} token budget`, toolEvents: [], toolCounts: {}, toolCallCount: 0, maxToolCalls, maxDurationMs, model: role.model, audit: [`Queued ${new Date().toISOString()}`],
      };
      this.runs.set(run.id, { snapshot: run });
      this.queue.push({ run, role, task: task.trim().slice(0, 24_000) });
    }
    this.publish();
    void this.pump();
  }

  async editRole(roleId: string): Promise<void> {
    const roles = await this.discoverRoles();
    const role = roles.find((item) => item.id === roleId);
    if (!role) return;
    const path = role.filePath ?? await this.writeBuiltinOverride(role);
    await vscode.window.showTextDocument(vscode.Uri.file(path));
    this.rolesCache = undefined;
    await this.open();
  }

  async resetRole(roleId: string): Promise<void> {
    const roles = await this.discoverRoles();
    const role = roles.find((item) => item.id === roleId);
    if (!role) return;
    const path = role.filePath ?? join(homedir(), ".pi", "agent", "agents", `${role.id}.md`);
    const choice = await vscode.window.showWarningMessage(`Reset Agent Lab role override for ${role.name}?`, { modal: true }, "Reset Role");
    if (choice !== "Reset Role") return;
    await rm(path, { force: true });
    this.rolesCache = undefined;
    await this.open();
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
    if (entry.timer) clearTimeout(entry.timer);
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

  async review(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry?.worktree) return;
    entry.snapshot.changes = await captureAgentChanges(entry.worktree);
    entry.snapshot.audit.push(`Captured ${entry.snapshot.changes.length} changed files for review`);
    this.publish();
  }

  async validate(runId: string, command: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry?.worktree) return;
    const resolved = command.trim() || vscode.workspace.getConfiguration("pide").get<string>("agentLabValidationCommand", "npm test");
    entry.snapshot.validation = await validateAgentWorktree(entry.worktree, resolved);
    entry.snapshot.audit.push(`Validation ${entry.snapshot.validation.ok ? "passed" : "failed"}: ${resolved}`);
    this.publish();
  }

  async applyAccepted(runId: string, paths: string[]): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry?.worktree) return;
    const patch = await createAgentPatch(entry.worktree, paths);
    await applyAgentPatch(entry.worktree.root, patch);
    entry.snapshot.worktree!.lifecycle = "integrated";
    entry.snapshot.audit.push(`Applied selected patch (${paths.length} files) to primary workspace`);
    this.publish();
  }

  async merge(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry?.worktree) return;
    const choice = await vscode.window.showWarningMessage(
      `Merge ${entry.worktree.branch} into the primary workspace? This creates a Git merge commit.`,
      { modal: true }, "Merge Agent Branch",
    );
    if (choice !== "Merge Agent Branch") return;
    if (await commitAgentWorktree(entry.worktree)) entry.snapshot.audit.push("Created reviewed agent-worktree commit for merge");
    await mergeAgentBranch(entry.worktree);
    entry.snapshot.worktree!.lifecycle = "integrated";
    entry.snapshot.audit.push("Explicitly approved and merged agent branch");
    this.publish();
  }

  async cleanupWorktree(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry?.worktree) return;
    await removeAgentWorktree(entry.worktree, entry.snapshot.worktree?.lifecycle === "integrated");
    entry.snapshot.worktree!.lifecycle = "cleaned";
    entry.snapshot.audit.push("Worktree cleaned up");
    this.publish();
  }

  async provideWorktreeContent(runId: string, path: string, side: "before" | "after"): Promise<string> {
    const worktree = this.runs.get(runId)?.worktree;
    return worktree ? (side === "before" ? await agentBeforeContent(worktree, path) : await agentAfterContent(worktree, path)) : "";
  }

  async openDiff(runId: string, path: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry?.worktree || !entry.snapshot.changes?.some((file) => file.path === path)) return;
    const revision = `${runId}-${Date.now()}`;
    const base = { scheme: "pide-agent-change", path: `/${path}`, query: new URLSearchParams({ runId, path, revision }).toString() };
    await vscode.commands.executeCommand("vscode.diff", vscode.Uri.from({ ...base, query: new URLSearchParams({ runId, path, revision, side: "before" }).toString() }), vscode.Uri.from({ ...base, query: new URLSearchParams({ runId, path, revision, side: "after" }).toString() }), `${path} — Agent worktree`, { preview: true });
  }

  async recoverAbandoned(): Promise<void> {
    for (const entry of this.runs.values()) {
      if (!entry.worktree || entry.snapshot.worktree?.lifecycle !== "active") continue;
      entry.snapshot.worktree.lifecycle = "abandoned";
      entry.snapshot.audit.push(await worktreeExists(entry.worktree.path)
        ? "Recovered abandoned worktree after VS Code restart"
        : "Worktree was missing on recovery");
    }
    this.publish();
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
    const writing = item.role.mode === "worktree";
    item.run.progress = writing ? "Creating isolated Git worktree…" : "Starting isolated read-only Pi process…";
    this.publish();

    const folder = this.workspaceFolder();
    if (!folder || !vscode.workspace.isTrusted) return this.fail(item.run, "Agent Lab requires a trusted filesystem workspace.");
    const config = vscode.workspace.getConfiguration("pide", folder.uri);
    let cwd: string;
    if (writing) {
      const worktree = await createAgentWorktree({ repository: folder.uri.fsPath, storageRoot: this.context.globalStorageUri.fsPath, id: item.run.id, role: item.role.name });
      entry.worktree = worktree;
      item.run.worktree = { root: worktree.root, path: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit, baselineStatus: worktree.baselineStatus, lifecycle: worktree.lifecycle, createdAt: worktree.createdAt };
      item.run.audit.push(`Created worktree ${worktree.branch} from ${worktree.baseCommit.slice(0, 10)}`);
      cwd = worktree.path;
    } else {
      cwd = await mkdtemp(join(tmpdir(), "pide-agent-lab-"));
      entry.cleanup = cwd;
    }
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
        const tool = applyToolRecord(item.run, event.record);
        if (tool) {
          const codingViolation = writing ? unsafeCodingTool(event.record, entry.worktree!) : undefined;
          const toolViolation = !item.role.tools.includes(tool) ? `Tool not allowed for ${item.role.name}: ${tool}` : undefined;
          const capViolation = item.run.toolCallCount > item.run.maxToolCalls ? `Agent exceeded tool-call cap (${item.run.maxToolCalls})` : undefined;
          if ((!writing && FORBIDDEN_TOOLS.has(tool)) || codingViolation || toolViolation || capViolation) {
            abortedForTool = true;
            item.run.status = "failed";
            item.run.error = codingViolation ?? toolViolation ?? capViolation ?? `Forbidden tool attempted: ${tool}`;
            item.run.progress = "Aborting unsafe or over-budget tool request.";
            void runtime.stop();
          } else item.run.progress = `Running · ${item.run.toolCallCount}/${item.run.maxToolCalls} tools · ${tool}`;
        }
        if (event.record.type === "agent_start") {
          item.run.status = "running";
          item.run.progress = "Running";
        }
        if (event.record.type === "agent_settled") void this.finish(item.run, result);
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
      approveWorkspace: writing ? config.get<boolean>("approveTrustedWorkspace", true) : false,
    });
    if (!started) return this.fail(item.run, runtime.health?.message ?? "Could not start Pi.");
    if (item.role.model) await applyRoleModel(runtime, item.role.model, item.run).catch((error) => item.run.audit.push(`Model selection failed: ${error instanceof Error ? error.message : String(error)}`));
    item.run.progress = "Prompt sent";
    this.publish();
    const prompt = writing
      ? codingAgentPrompt(item.role, item.task, entry.worktree!, config.get<number>("agentLabTokenBudget", 12_000))
      : agentPrompt(item.role, item.task, folder.uri.fsPath, config.get<number>("agentLabTokenBudget", 12_000));
    try {
      const entryForTimer = this.runs.get(item.run.id);
      if (entryForTimer) entryForTimer.timer = setTimeout(() => {
        item.run.status = "failed";
        item.run.error = `Agent exceeded duration cap (${Math.round(item.run.maxDurationMs / 60_000)}m)`;
        item.run.progress = "Aborting duration cap.";
        void runtime.stop();
      }, item.run.maxDurationMs);
      await runtime.client?.request({ type: "prompt", message: prompt }, 60_000);
    } catch (error) {
      this.fail(item.run, error instanceof Error ? error.message : String(error));
    }
  }

  private async finish(run: AgentRunSnapshot, result: string): Promise<void> {
    const entry = this.runs.get(run.id);
    if (!entry || ["failed", "cancelled"].includes(run.status)) return;
    if (!result.trim() && !entry.worktree) {
      run.status = "failed";
      run.result = "No final answer was returned before the agent stopped.";
      run.error = "No final answer returned";
      run.progress = "Finished without a final answer";
    } else {
      run.status = "succeeded";
      run.result = (result.trim() || "No textual result returned; review captured worktree changes.").slice(0, 64_000);
      run.progress = "Complete";
    }
    run.finishedAt = Date.now();
    run.durationMs = run.startedAt ? run.finishedAt - run.startedAt : undefined;
    if (entry.timer) clearTimeout(entry.timer);
    await entry.runtime?.stop().catch(() => undefined);
    if (entry.worktree) {
      run.changes = await captureAgentChanges(entry.worktree);
      run.worktree!.lifecycle = "complete";
      run.audit.push(`Agent completed; captured ${run.changes.length} changed files`);
    } else await this.cleanup(entry);
    this.publish();
  }

  private fail(run: AgentRunSnapshot, error: string): void {
    const entry = this.runs.get(run.id);
    run.status = "failed";
    run.error = error;
    run.progress = "Failed";
    run.finishedAt = Date.now();
    run.durationMs = run.startedAt ? run.finishedAt - run.startedAt : undefined;
    if (entry?.timer) clearTimeout(entry.timer);
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

  private async writeBuiltinOverride(role: AgentRole): Promise<string> {
    const dir = join(homedir(), ".pi", "agent", "agents");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${role.id}.md`);
    await writeFile(path, roleToMarkdown(role), "utf8");
    return path;
  }

  private maxConcurrent(): number {
    const value = vscode.workspace.getConfiguration("pide").get<number>("agentLabMaxConcurrent", 4);
    return Math.max(1, Math.min(8, Math.floor(value || 4)));
  }

  private snapshots(): AgentRunSnapshot[] {
    return Array.from(this.runs.values()).map((entry) => {
      entry.snapshot.sources = extractAgentSources(entry.snapshot);
      return entry.snapshot;
    }).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  private publish(): void {
    void this.context.workspaceState.update("pide.agentLabRuns", this.snapshots().filter((run) => Boolean(run.worktree)).slice(0, 40));
    void this.open();
  }
}

function builtinRoles(): AgentRole[] {
  const base = { invocation: "manual" as const, source: "builtin" as const };
  const codeTools = ["read", "codebase_search", "filesystem_map", "git_change_map"];
  return [
    { ...base, id: "architect", name: "Architect", description: "Designs approaches, boundaries, risks, and implementation plans.", tools: [...codeTools, "math_tool"], maxToolCalls: 16, prompt: "Focus on architecture, sequencing, interfaces, and risk tradeoffs. Avoid broad web research unless explicitly requested." },
    { ...base, id: "explorer", name: "Explorer", description: "Maps unfamiliar code and finds likely edit/test targets.", tools: codeTools, maxToolCalls: 18, prompt: "Explore structure and identify relevant files, symbols, and dependencies. Prefer filesystem_map and codebase_search over repeated reads." },
    { ...base, id: "reviewer", name: "Reviewer", description: "Reviews changes for correctness, maintainability, and regressions.", tools: [...codeTools, "test_failure_summarizer"], maxToolCalls: 18, prompt: "Review critically. Prioritize concrete issues and verification gaps. Do not browse the web unless asked." },
    { ...base, id: "tester", name: "Tester", description: "Plans validation and diagnoses failures without modifying files.", tools: [...codeTools, "test_failure_summarizer"], maxToolCalls: 16, prompt: "Focus on tests, reproduction, logs, and minimal validation commands." },
    { ...base, id: "researcher", name: "Researcher", description: "Gathers bounded external or documentation context.", tools: ["web_fetch", "brave_search", "read"], maxToolCalls: 14, prompt: "Research only what is necessary. Prefer official documentation and primary sources. Return 3-6 cited links, key findings, uncertainty, and recommended next steps." },
    { ...base, id: "security", name: "Security", description: "Looks for security, privacy, trust, and supply-chain risks.", tools: [...codeTools, "web_fetch"], maxToolCalls: 16, prompt: "Focus on concrete abuse cases, secrets, auth boundaries, and mitigations." },
    { ...base, id: "documentation", name: "Documentation", description: "Improves explanations, docs structure, and user-facing clarity.", tools: ["read", "codebase_search", "web_fetch", "brave_search"], maxToolCalls: 14, prompt: "Focus on concise documentation gaps and suggested wording. When asked for docs, prefer official docs and return links plus concrete writing/styling recommendations." },
    { ...base, id: "implementer", name: "Implementer", description: "Implements an approved task in an isolated Git worktree for review.", tools: ["read", "edit", "write"], maxToolCalls: 40, mode: "worktree", prompt: "Implement only the requested change. Work only inside your assigned worktree. Do not use shell tools; PiDE runs validation separately. Summarize changed files, tests to run, risks, and review notes." },
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
  const mode = frontmatter.mode === "worktree" ? "worktree" : "read-only";
  const tools = parseList(frontmatter.tools || READ_ONLY_TOOLS.join(" "));
  return {
    id: frontmatter.id || `${source}:${slug(name)}`,
    name,
    description: frontmatter.description || body.split(/\r?\n/).find((line) => line.trim())?.slice(0, 160) || "Custom read-only Agent Lab role",
    model: frontmatter.model || undefined,
    tools: mode === "worktree" ? tools.filter((tool) => ["read", "edit", "write"].includes(tool)) : tools.filter((tool) => !FORBIDDEN_TOOLS.has(tool)),
    invocation: frontmatter.invocation === "automatic" ? "automatic" : "manual",
    source,
    prompt: body.trim().slice(0, 8_000),
    skills: parseList(frontmatter.skills),
    maxToolCalls: frontmatter.maxToolCalls ? Number(frontmatter.maxToolCalls) : undefined,
    maxDurationMs: frontmatter.maxDurationMinutes ? Number(frontmatter.maxDurationMinutes) * 60_000 : undefined,
    mode,
    filePath: path,
  };
}

function roleToMarkdown(role: AgentRole): string {
  return `---\nid: ${role.id}\nname: ${role.name}\ndescription: ${role.description}\nmodel: ${role.model ?? ""}\ntools: ${role.tools.join(" ")}\nskills: ${(role.skills ?? []).join(" ")}\ninvocation: ${role.invocation}\nmode: ${role.mode ?? "read-only"}\nmaxToolCalls: ${role.maxToolCalls ?? ""}\nmaxDurationMinutes: ${role.maxDurationMs ? Math.round(role.maxDurationMs / 60_000) : ""}\n---\n\n${role.prompt}\n`;
}

function parseList(value?: string): string[] {
  return value ? value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean) : [];
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

function codingAgentPrompt(role: AgentRole, task: string, worktree: AgentWorktree, budget: number): string {
  return `You are a PiDE coding subagent named ${role.name}.\n\nWORKTREE SAFETY CONTRACT:\n- You may modify files only inside this assigned Git worktree: ${worktree.path}\n- Allowed tools are exactly: read, edit, write. Any other tool request is aborted.\n- Preferred skills/context: ${(role.skills ?? []).join(", ") || "none"}.\n- Never access, modify, or run commands in the primary workspace: ${worktree.root}\n- Do not commit, merge, rebase, push, alter Git remotes, or delete the worktree.\n- Implement only the requested task. Keep scope narrow. PiDE runs validation separately.\n- Token budget: ${budget}. Stop early if the budget is at risk.\n\nRole instructions:\n${role.prompt}\n\nTask:\n${task}\n\nReturn a compact summary of changed files, validation to run, risks, and review notes. Your work will be reviewed before any integration.`;
}

function agentPrompt(role: AgentRole, task: string, workspacePath: string, budget: number): string {
  return `You are a PiDE Agent Lab subagent named ${role.name}.\n\nREAD-ONLY SAFETY CONTRACT:\n- Do not modify files, do not write files, do not run shell commands that mutate state, and do not use edit/write/bash.\n- Allowed tools are exactly: ${role.tools.join(", ")}. Any other tool request is aborted.\n- Preferred skills/context: ${(role.skills ?? []).join(", ") || "none"}.\n- Work from an isolated temporary process. Treat workspace path as read-only context: ${workspacePath}.\n- Keep the response bounded. Do not write noisy transcripts to Honcho memory.\n- Token budget: ${budget}. Stop early if the budget is at risk.\n\nRole instructions:\n${role.prompt}\n\nTask from parent PiDE session:\n${task}\n\nReturn: status, key findings, evidence/file references, risks, and recommended next steps. Do not apply changes.`;
}

async function applyRoleModel(runtime: PiRuntime, model: string, run: AgentRunSnapshot): Promise<void> {
  const parts = model.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Role model must be provider/model: ${model}`);
  const provider = parts[0];
  const modelId = parts.slice(1).join("/");
  await runtime.client?.request({ type: "set_model", provider, modelId }, 60_000);
  run.model = model;
  run.audit.push(`Selected role model ${model}`);
}

function extractTextDelta(record: RpcRecord): string {
  if (record.type !== "message_update") return "";
  const event = record.assistantMessageEvent as Record<string, unknown> | undefined;
  return event?.type === "text_delta" && typeof event.delta === "string" ? event.delta : "";
}

function applyToolRecord(run: AgentRunSnapshot, record: RpcRecord): string | undefined {
  const id = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
  if (record.type === "tool_execution_start") {
    const tool = typeof record.toolName === "string" ? record.toolName : undefined;
    if (!tool) return undefined;
    run.toolCallCount += 1;
    run.toolCounts[tool] = (run.toolCounts[tool] ?? 0) + 1;
    run.lastTool = tool;
    run.toolEvents.push({
      id,
      tool,
      status: "running",
      args: boundedToolArgs(record.args),
    });
    run.toolEvents = run.toolEvents.slice(-80);
    return tool;
  }
  if (record.type === "tool_execution_end" && id) {
    const existing = [...run.toolEvents].reverse().find((event) => event.id === id);
    if (existing) {
      existing.status = record.isError === true ? "failed" : "done";
      existing.isError = record.isError === true;
      existing.result = toolResultText(record.result).slice(0, 4_000);
    }
  }
  return undefined;
}

function toolName(record: RpcRecord): string | undefined {
  if (record.type !== "tool_execution_start") return undefined;
  return typeof record.toolName === "string" ? record.toolName : undefined;
}

function unsafeCodingTool(record: RpcRecord, worktree: AgentWorktree): string | undefined {
  const tool = toolName(record);
  if (!tool || !["read", "edit", "write"].includes(tool)) return `Forbidden coding-agent tool attempted: ${tool ?? "unknown"}`;
  const args = record.args as Record<string, unknown> | undefined;
  const path = typeof args?.path === "string" ? args.path : undefined;
  if (!path) return `Coding-agent ${tool} request lacked a file path`;
  const absolute = resolve(worktree.path, path);
  const rel = relative(worktree.path, absolute);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    ? `Coding-agent path escaped assigned worktree: ${path}`
    : undefined;
}

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent"; }
