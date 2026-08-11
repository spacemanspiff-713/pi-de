import { readdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface SessionSummary {
  file: string;
  id: string;
  cwd: string;
  name?: string;
  preview: string;
  searchText: string;
  updatedAt: number;
  createdAt: number;
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  tokens: number;
  cost: number;
  model?: string;
  archived: boolean;
}

export async function discoverSessions(options: {
  cwd: string;
  currentSessionFile?: string;
  agentDir?: string;
}): Promise<SessionSummary[]> {
  const agentDir = expandHome(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  const roots = new Set<string>([join(agentDir, "sessions")]);
  if (process.env.PI_CODING_AGENT_SESSION_DIR) roots.add(expandHome(process.env.PI_CODING_AGENT_SESSION_DIR));
  if (options.currentSessionFile) roots.add(dirname(options.currentSessionFile));

  const globalSettings = await readJson(join(agentDir, "settings.json"));
  if (typeof globalSettings.sessionDir === "string") {
    roots.add(resolveSettingPath(globalSettings.sessionDir, agentDir));
  }
  const projectSettings = await readJson(join(options.cwd, ".pi", "settings.json"));
  if (typeof projectSettings.sessionDir === "string") {
    roots.add(resolveSettingPath(projectSettings.sessionDir, options.cwd));
  }

  const files = new Set<string>();
  await Promise.all(Array.from(roots).map(async (root) => {
    for (const file of await findSessionFiles(root, 4)) files.add(file);
  }));

  const targetCwd = resolve(options.cwd);
  const summaries = await Promise.all(Array.from(files).map((file) => parseSession(file).catch(() => undefined)));
  return summaries
    .filter((session): session is SessionSummary => Boolean(session && resolve(session.cwd) === targetCwd))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function archiveSession(file: string): Promise<string> {
  const archiveDir = join(dirname(file), ".archive");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(archiveDir, { recursive: true }));
  const destination = join(archiveDir, basename(file));
  await rename(file, destination);
  return destination;
}

export async function restoreArchivedSession(file: string): Promise<string> {
  if (basename(dirname(file)) !== ".archive") return file;
  const destination = join(dirname(dirname(file)), basename(file));
  await rename(file, destination);
  return destination;
}

export async function parseSession(file: string): Promise<SessionSummary | undefined> {
  const [raw, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return undefined;
  const header = JSON.parse(lines[0]) as Record<string, unknown>;
  if (header.type !== "session" || typeof header.cwd !== "string") return undefined;

  let name: string | undefined;
  let preview = "";
  let lastUserText = "";
  const searchableUserText: string[] = [];
  let messageCount = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let tokens = 0;
  let cost = 0;
  let model: string | undefined;

  for (const line of lines.slice(1)) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (entry.type === "session_info") name = typeof entry.name === "string" ? entry.name : undefined;
    if (entry.type === "model_change" && entry.provider && entry.modelId) model = `${String(entry.provider)}/${String(entry.modelId)}`;
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const usage = asRecord(entry.usage);
      tokens += usageTokens(usage);
      cost += usageCost(usage);
    }
    if (entry.type !== "message") continue;
    messageCount++;
    const message = asRecord(entry.message);
    const role = String(message.role ?? "");
    if (role === "user") {
      userMessages++;
      const text = messageText(message.content);
      if (!preview && text) preview = text;
      if (text) {
        lastUserText = text;
        if (searchableUserText.join("\n").length < 50_000) searchableUserText.push(text);
      }
    } else if (role === "assistant") {
      assistantMessages++;
      const usage = asRecord(message.usage);
      tokens += usageTokens(usage);
      cost += usageCost(usage);
      if (message.provider && message.model) model = `${String(message.provider)}/${String(message.model)}`;
      toolCalls += asArray(message.content).filter((block) => asRecord(block).type === "toolCall").length;
    } else if (role === "toolResult") {
      const usage = asRecord(message.usage);
      tokens += usageTokens(usage);
      cost += usageCost(usage);
    }
  }

  const combinedPreview = lastUserText && lastUserText !== preview ? `${preview}\n…\n${lastUserText}` : preview;
  return {
    file,
    id: String(header.id ?? basename(file, ".jsonl")),
    cwd: header.cwd,
    name,
    preview: truncate(combinedPreview || "Empty session", 320),
    searchText: truncate(searchableUserText.join("\n"), 50_000),
    updatedAt: info.mtimeMs,
    createdAt: Date.parse(String(header.timestamp ?? "")) || info.birthtimeMs || info.mtimeMs,
    messageCount,
    userMessages,
    assistantMessages,
    toolCalls,
    tokens,
    cost,
    model,
    archived: file.split(/[\\/]/).includes(".archive"),
  };
}

async function findSessionFiles(root: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return []; }
  const files: string[] = [];
  await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await findSessionFiles(path, depth - 1));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }));
  return files;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  return asArray(content)
    .map((block) => {
      const item = asRecord(block);
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function usageTokens(usage: Record<string, unknown>): number {
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .filter((value): value is number => typeof value === "number")
    .reduce((sum, value) => sum + value, 0);
}

function usageCost(usage: Record<string, unknown>): number {
  const cost = asRecord(usage.cost);
  return typeof cost.total === "number" ? cost.total : 0;
}

function resolveSettingPath(path: string, base: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
