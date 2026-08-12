import { describe, expect, it } from "vitest";
import {
  composeAgentTask,
  dispatchSummary,
  fallbackDispatchRoles,
  parseDispatchMode,
  resolveDispatchRoles,
  withReviewContext,
} from "../src/dispatch";

describe("dispatch console helpers", () => {
  it("resolves presets, prefixes agent tasks, and keeps slash-safe fallbacks", () => {
    expect(parseDispatchMode("research")).toBe("research");
    expect(parseDispatchMode("nope")).toBe("ask");
    expect(resolveDispatchRoles(["researcher", "missing"], ["architect", "researcher"])).toEqual(["researcher"]);
    expect(fallbackDispatchRoles("implement", [
      { id: "coder", mode: "worktree" },
      { id: "architect" },
    ])).toEqual(["coder"]);
    expect(composeAgentTask("research", "Find VS Code webview docs")).toContain("Prefer official documentation");
    expect(withReviewContext("review", "Check the latest change")).toBe("Check the latest change @git-diff");
    expect(withReviewContext("review", "Check @problems")).toBe("Check @problems");
    expect(dispatchSummary({ includePi: true, roleIds: ["researcher"] }, [{ id: "researcher", name: "Researcher" }])).toBe("Pi + Researcher");
    expect(dispatchSummary({ includePi: false, roleIds: [] }, [])).toBe("Pi thread");
  });
});
