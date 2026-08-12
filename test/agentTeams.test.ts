import { describe, expect, it } from "vitest";
import { applyTeam, builtinTeams, mergeTeams, parseTeamMarkdown, playbookPreview } from "../src/agentTeams";

describe("saved agent teams", () => {
  it("parses Markdown team files and applies them as dispatch presets", () => {
    const custom = parseTeamMarkdown(`---
id: custom-docs
name: Custom Docs
description: Research then write docs
includePi: true
mode: research
roles: researcher documentation extra
---

1. Research official docs.
2. Draft wording.
`, "user", "/tmp/custom-docs.md");
    expect(custom).toMatchObject({
      id: "custom-docs",
      includePi: true,
      mode: "research",
      roleIds: ["researcher", "documentation", "extra"],
      source: "user",
    });
    expect(applyTeam(custom, ["researcher", "documentation", "architect"])).toEqual({
      id: "custom-docs",
      mode: "research",
      includePi: true,
      roleIds: ["researcher", "documentation"],
      playbook: "1. Research official docs.\n2. Draft wording.",
    });
    const teams = mergeTeams([...builtinTeams(), custom!]);
    expect(teams.some((team) => team.id === "research-docs")).toBe(true);
    expect(teams.find((team) => team.id === "custom-docs")?.name).toBe("Custom Docs");
    expect(playbookPreview("  one   two three  ", 7)).toBe("one tw…");
  });
});
