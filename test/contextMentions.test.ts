import { describe, expect, it } from "vitest";
import { contextScore, extractMentions, mentionText, truncateContext } from "../src/contextMentions";

describe("context mentions", () => {
  it("quotes workspace paths containing spaces", () => {
    expect(mentionText("src/rebuy errors/theme.liquid")).toBe('@"src/rebuy errors/theme.liquid"');
    expect(mentionText("src/theme.liquid")).toBe("@src/theme.liquid");
  });

  it("extracts built-in and quoted file mentions without treating email as context", () => {
    expect(extractMentions('Review @selection and @"src/rebuy errors/app.js". Email a@b.com')).toEqual([
      "selection",
      "src/rebuy errors/app.js",
    ]);
  });

  it("deduplicates mentions and strips sentence punctuation", () => {
    expect(extractMentions("Check @problems, then @problems and @git-diff.")).toEqual([
      "problems",
      "git-diff",
    ]);
  });

  it("ranks exact and basename matches above path substrings", () => {
    const exact = contextScore({ label: "selection", kind: "context" }, "selection");
    const basename = contextScore({ label: "src/components/selection.ts", kind: "file" }, "selection.ts");
    const substring = contextScore({ label: "src/components/selection-helper.ts", kind: "file" }, "selection");
    expect(exact).toBeGreaterThan(basename);
    expect(basename).toBeGreaterThan(substring);
  });

  it("bounds attached context", () => {
    const result = truncateContext("x".repeat(1_000), 200);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).toContain("Context truncated");
  });
});
