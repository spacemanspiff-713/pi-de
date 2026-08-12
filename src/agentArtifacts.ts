export interface AgentToolEventLike {
  tool: string;
  status?: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface AgentSource {
  url: string;
  title: string;
  status: "ok" | "failed" | "mentioned";
  kind: "official" | "secondary" | "community";
  note?: string;
  tool?: string;
}

const OFFICIAL_HOSTS = [
  /(?:^|\.)code\.visualstudio\.com$/i,
  /(?:^|\.)docs\.github\.com$/i,
  /(?:^|\.)learn\.microsoft\.com$/i,
  /(?:^|\.)developer\.mozilla\.org$/i,
  /(?:^|\.)docs\.npmjs\.com$/i,
  /(?:^|\.)nodejs\.org$/i,
  /(?:^|\.)pi\.dev$/i,
];

export function previewText(text: string | undefined, max = 180): string {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(1, max - 1))}…`;
}

export function extractAgentSources(input: { result?: string; toolEvents?: AgentToolEventLike[] }): AgentSource[] {
  const byUrl = new Map<string, AgentSource>();
  const remember = (source: AgentSource) => {
    const key = normalizeUrl(source.url);
    if (!key) return;
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, { ...source, url: key });
      return;
    }
    if (source.status === "failed" || existing.status === "mentioned") {
      byUrl.set(key, {
        ...existing,
        ...source,
        url: key,
        title: source.title || existing.title,
        note: source.note || existing.note,
        tool: source.tool || existing.tool,
      });
    } else if (!existing.title && source.title) {
      existing.title = source.title;
    }
  };

  for (const event of input.toolEvents || []) {
    const url = stringArg(event.args, "url") || stringArg(event.args, "href");
    const query = stringArg(event.args, "query");
    if (url) {
      remember({
        url,
        title: query || titleFromUrl(url),
        status: event.isError ? "failed" : "ok",
        kind: classifyHost(url),
        note: event.isError ? previewText(event.result, 160) || "Fetch failed" : query ? `query: ${query}` : undefined,
        tool: event.tool,
      });
    }
    for (const found of urlsFromText(event.result || "")) {
      remember({
        url: found.url,
        title: found.title || titleFromUrl(found.url),
        status: event.isError ? "failed" : "ok",
        kind: classifyHost(found.url),
        tool: event.tool,
      });
    }
  }

  for (const found of urlsFromText(input.result || "")) {
    remember({
      url: found.url,
      title: found.title || titleFromUrl(found.url),
      status: "mentioned",
      kind: classifyHost(found.url),
      note: "Cited in final answer",
    });
  }

  return Array.from(byUrl.values());
}

export function sourceSummary(sources: AgentSource[]): string {
  if (!sources.length) return "";
  const official = sources.filter((source) => source.kind === "official").length;
  const secondary = sources.filter((source) => source.kind === "secondary").length;
  const community = sources.filter((source) => source.kind === "community").length;
  const failed = sources.filter((source) => source.status === "failed").length;
  return [
    official ? `${official} official` : "",
    secondary ? `${secondary} secondary` : "",
    community ? `${community} community` : "",
    failed ? `${failed} failed` : "",
  ].filter(Boolean).join(" · ") || `${sources.length} sources`;
}

export function boundedToolArgs(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    if (typeof item === "string") output[key] = item.slice(0, 2_000);
    else if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
    else if (typeof item === "boolean") output[key] = item;
  }
  return Object.keys(output).length ? output : undefined;
}

export function toolResultText(result: unknown): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  const record = result as { content?: Array<{ type?: string; text?: string }> };
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content.filter((item) => item && item.type === "text" && typeof item.text === "string").map((item) => item.text || "").join("\n");
  return text || "";
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function urlsFromText(text: string): Array<{ url: string; title: string }> {
  const found: Array<{ url: string; title: string }> = [];
  for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    found.push({ title: match[1].trim(), url: match[2] });
  }
  for (const match of text.matchAll(/https?:\/\/[^\s)\]}>'"]+/g)) {
    found.push({ title: "", url: match[0] });
  }
  return found;
}

function normalizeUrl(value: string): string {
  return value.replace(/[.,;:]+$/g, "").trim();
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname.replace(/\/+/g, "/")).replace(/\/$/, "");
    const leaf = path.split("/").filter(Boolean).slice(-2).join("/") || parsed.hostname;
    return leaf || parsed.hostname;
  } catch {
    return url;
  }
}

function classifyHost(url: string): AgentSource["kind"] {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const path = new URL(url).pathname;
    if (OFFICIAL_HOSTS.some((pattern) => pattern.test(host))) return "official";
    if (host === "github.com" && /^\/microsoft(\/|$)/i.test(path)) return "official";
    if (/(^|\.)(stackoverflow|stackexchange|reddit|medium|dev\.to|hashnode)\.com$/i.test(host) || host === "dev.to") return "community";
    if (host === "github.com") return "community";
    return "secondary";
  } catch {
    return "secondary";
  }
}
