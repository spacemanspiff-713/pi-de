import { describe, expect, it } from "vitest";
import { PiRuntimeManager } from "../src/runtime/piRuntimeManager";

describe("PiRuntimeManager", () => {
  it("persists and activates session tabs", () => {
    const manager = new PiRuntimeManager(() => undefined);
    const tab = manager.ensureTab({ sessionFile: "/tmp/a.jsonl", title: "A" });
    manager.activate(tab.id);
    manager.markWorking(tab.id, true);
    expect(manager.activeId).toBe(tab.id);
    expect(manager.writeLeaseOwner).toBe(tab.id);
    manager.markWorking(tab.id, false);
    expect(manager.allTabs.find((item) => item.id === tab.id)?.status).toBe("idle");
  });

  it("hydrates previously open tabs", () => {
    const manager = new PiRuntimeManager(() => undefined);
    manager.hydrate([{ id: "session:/tmp/b.jsonl", sessionFile: "/tmp/b.jsonl", title: "B", lastActive: 10 }], "session:/tmp/b.jsonl");
    expect(manager.activeId).toBe("session:/tmp/b.jsonl");
    expect(manager.activeTab.title).toBe("B");
  });
});
