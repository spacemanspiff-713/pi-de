export type DispatchMode = "ask" | "plan" | "research" | "implement" | "review";

export interface DispatchPreset {
  mode: DispatchMode;
  label: string;
  includePi: boolean;
  roleIds: string[];
  placeholder: string;
}

export interface DispatchTarget {
  includePi: boolean;
  roleIds: string[];
}

export const DISPATCH_PRESETS: DispatchPreset[] = [
  { mode: "ask", label: "Ask", includePi: true, roleIds: [], placeholder: "Ask Pi…  (@ for context, / for commands)" },
  { mode: "plan", label: "Plan", includePi: false, roleIds: ["architect"], placeholder: "Describe the change to plan…" },
  { mode: "research", label: "Research", includePi: false, roleIds: ["researcher"], placeholder: "What should the researcher look up?" },
  { mode: "implement", label: "Implement", includePi: false, roleIds: ["implementer"], placeholder: "Describe the approved worktree task…" },
  { mode: "review", label: "Review", includePi: false, roleIds: ["reviewer"], placeholder: "What should be reviewed?" },
];

const AGENT_PREFIX: Record<DispatchMode, string> = {
  ask: "",
  plan: "Create a bounded implementation plan for this task. Do not modify files.\n\n",
  research: "Research this question. Prefer official documentation and primary sources. Return cited sources, key findings, uncertainty, and next steps.\n\n",
  implement: "Implement only this approved task in your assigned Git worktree. Keep the change reviewable.\n\n",
  review: "Review this change or plan. Focus on concrete issues, risks, and verification gaps. Do not modify files.\n\n",
};

export function dispatchPreset(mode: DispatchMode | string): DispatchPreset {
  return DISPATCH_PRESETS.find((item) => item.mode === mode) ?? DISPATCH_PRESETS[0];
}

export function resolveDispatchRoles(roleIds: string[], availableIds: string[]): string[] {
  const available = new Set(availableIds);
  return Array.from(new Set(roleIds)).filter((id) => available.has(id)).slice(0, 16);
}

export function fallbackDispatchRoles(mode: DispatchMode | string, available: Array<{ id: string; tools?: string[]; mode?: string }>): string[] {
  const preset = dispatchPreset(mode);
  const byId = new Set(available.map((role) => role.id));
  const exact = preset.roleIds.filter((id) => byId.has(id));
  if (exact.length) return exact;
  if (preset.mode === "research") return available.filter((role) => (role.tools || []).includes("web_fetch")).map((role) => role.id).slice(0, 1);
  if (preset.mode === "implement") return available.filter((role) => role.mode === "worktree").map((role) => role.id).slice(0, 1);
  if (preset.mode === "plan" || preset.mode === "review") return available.filter((role) => role.mode !== "worktree").map((role) => role.id).slice(0, 1);
  return [];
}

export function composeAgentTask(mode: DispatchMode | string, text: string): string {
  return `${AGENT_PREFIX[dispatchPreset(mode).mode]}${text.trim()}`.slice(0, 24_000);
}

export function withReviewContext(mode: DispatchMode | string, text: string): string {
  if (dispatchPreset(mode).mode !== "review") return text;
  return /(?:^|\s)@(?:git-diff|problems)\b/.test(text) ? text : `${text.trim()} @git-diff`.trim();
}

export function dispatchSummary(target: DispatchTarget, available: Array<{ id: string; name: string }>): string {
  const names = target.roleIds.map((id) => available.find((role) => role.id === id)?.name || id);
  if (target.includePi && names.length) return `Pi + ${names.join(", ")}`;
  if (names.length) return names.join(", ");
  return "Pi thread";
}

export function parseDispatchMode(value: unknown): DispatchMode {
  return DISPATCH_PRESETS.some((item) => item.mode === value) ? value as DispatchMode : "ask";
}
