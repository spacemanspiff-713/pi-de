import { parseDispatchMode, resolveDispatchRoles, type DispatchMode } from "./dispatch";

export interface AgentTeam {
  id: string;
  name: string;
  description: string;
  includePi: boolean;
  mode: DispatchMode;
  roleIds: string[];
  playbook: string;
  source: "builtin" | "user" | "project";
  filePath?: string;
}

export interface AppliedTeam {
  id: string;
  mode: DispatchMode;
  includePi: boolean;
  roleIds: string[];
  playbook: string;
}

export function builtinTeams(): AgentTeam[] {
  return [
    team("research-docs", "Research + Docs", "Research official sources, then draft documentation.", false, "research", ["researcher", "documentation"], "1. Researcher gathers official sources and failed-fetch notes.\n2. Documentation turns those findings into concrete wording.\nDo not implement code in this team."),
    team("plan-review", "Plan + Explore + Review", "Map the change, then review the plan before any writing.", false, "plan", ["architect", "explorer", "reviewer"], "1. Architect proposes a bounded plan.\n2. Explorer identifies likely files and test targets.\n3. Reviewer looks for gaps before implementation."),
    team("implement-review", "Implement + Test + Review", "Implement in a worktree, then validate and review.", false, "implement", ["implementer", "tester", "reviewer"], "1. Implementer works only in the assigned worktree.\n2. Tester plans validation and failure checks.\n3. Reviewer inspects the resulting change set.\nNo automatic merge."),
    team("security-review", "Security Review", "Look for trust, auth, and supply-chain risks.", false, "review", ["security", "reviewer"], "1. Security lists concrete abuse cases.\n2. Reviewer checks verification gaps and residual risk.\nAttach @git-diff or @problems when reviewing existing work."),
  ];
}

export function parseTeamMarkdown(raw: string, source: "user" | "project", filePath: string): AgentTeam | undefined {
  if (!raw.trim()) return undefined;
  const { frontmatter, body } = splitFrontmatter(raw);
  const name = frontmatter.name || fileName(filePath);
  const roleIds = parseList(frontmatter.roles || frontmatter.roleIds);
  if (!name) return undefined;
  return {
    id: frontmatter.id || `${source}:${slug(name)}`,
    name,
    description: frontmatter.description || body.split(/\r?\n/).find((line) => line.trim())?.slice(0, 160) || "Saved Agent Lab team",
    includePi: parseBoolean(frontmatter.includePi, false),
    mode: parseDispatchMode(frontmatter.mode || "ask"),
    roleIds: roleIds.slice(0, 16),
    playbook: body.trim().slice(0, 8_000),
    source,
    filePath,
  };
}

export function mergeTeams(teams: AgentTeam[]): AgentTeam[] {
  const byId = new Map<string, AgentTeam>();
  for (const item of teams) byId.set(item.id, item);
  return Array.from(byId.values());
}

export function applyTeam(team: AgentTeam | undefined, availableIds: string[]): AppliedTeam | undefined {
  if (!team) return undefined;
  return {
    id: team.id,
    mode: parseDispatchMode(team.mode),
    includePi: team.includePi,
    roleIds: resolveDispatchRoles(team.roleIds, availableIds),
    playbook: team.playbook,
  };
}

export function playbookPreview(text: string, max = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(1, max - 1))}…`;
}

function team(id: string, name: string, description: string, includePi: boolean, mode: DispatchMode, roleIds: string[], playbook: string): AgentTeam {
  return { id, name, description, includePi, mode, roleIds, playbook, source: "builtin" };
}

function parseList(value?: string): string[] {
  return value ? value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean) : [];
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
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

function fileName(path: string): string {
  const leaf = path.split(/[\\/]/).pop() || "team";
  return leaf.replace(/\.md$/i, "");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "team";
}
