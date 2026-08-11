import { basename } from "node:path";

export interface ContextCandidate {
  label: string;
  kind: "context" | "file";
}

export function mentionText(label: string): string {
  return /\s/.test(label) ? `@"${label.replaceAll('"', '\\"')}"` : `@${label}`;
}

export function extractMentions(text: string): string[] {
  const mentions: string[] = [];
  const pattern = /(^|\s)@(?:"([^"]+)"|([^\s]+))/g;
  for (const match of text.matchAll(pattern)) {
    const mention = (match[2] ?? match[3] ?? "").replace(/[),.;:!?]+$/, "");
    if (mention && !mentions.includes(mention)) mentions.push(mention);
  }
  return mentions;
}

export function contextScore(item: ContextCandidate, query: string): number {
  if (!query) return item.kind === "context" ? 200 : 20;
  const label = item.label.toLowerCase();
  const base = basename(label);
  if (label === query || base === query) return item.kind === "context" ? 320 : 300;
  if (label.startsWith(query) || base.startsWith(query)) return item.kind === "context" ? 260 : 240;
  if (base.includes(query)) return 200;
  if (label.includes(query)) return 160;
  const terms = query.split(/[^a-z0-9_.-]+/).filter(Boolean);
  const hits = terms.filter((term) => label.includes(term)).length;
  return hits ? 80 + hits * 10 : 0;
}

export function truncateContext(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, Math.max(0, maxChars - 80))}\n\n[Context truncated at ${maxChars} characters]`;
}
