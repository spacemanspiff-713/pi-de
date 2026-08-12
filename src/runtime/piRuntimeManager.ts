import { EventEmitter } from "node:events";
import { basename } from "node:path";
import type { RuntimeHealth } from "../protocol";
import { PiRuntime, type PiRuntimeEvent, type PiRuntimeStartOptions } from "./piRuntime";

export interface RuntimeTab {
  id: string;
  sessionFile?: string;
  title: string;
  status: "dormant" | "starting" | "ready" | "working" | "idle" | "error" | "stopped";
  unread: boolean;
  lastActive: number;
}

export type PiRuntimeManagerEvent = PiRuntimeEvent & { runtimeId: string };

export class PiRuntimeManager {
  private readonly events = new EventEmitter();
  private readonly runtimes = new Map<string, PiRuntime>();
  private readonly tabs = new Map<string, RuntimeTab>();
  private readonly unsubscribers = new Map<string, () => void>();
  private currentId = "default";

  constructor(private readonly log: (runtimeId: string, line: string) => void) {
    this.ensureTab({ id: "default", title: "Current session" });
  }

  get activeId(): string { return this.currentId; }
  get activeRuntime(): PiRuntime { return this.runtimeFor(this.currentId); }
  get activeTab(): RuntimeTab { return this.tabs.get(this.currentId) ?? this.ensureTab({ id: this.currentId }); }
  get allTabs(): RuntimeTab[] { return Array.from(this.tabs.values()).sort((a, b) => b.lastActive - a.lastActive); }

  hydrate(tabs: Array<Pick<RuntimeTab, "id" | "sessionFile" | "title" | "lastActive">>, activeId?: string): void {
    for (const tab of tabs) this.ensureTab({ id: tab.id, sessionFile: tab.sessionFile, title: tab.title }).lastActive = tab.lastActive;
    if (activeId && this.tabs.has(activeId)) this.currentId = activeId;
  }
  get writeLeaseOwner(): string | undefined { return this.allTabs.find((tab) => tab.status === "working")?.id; }

  onEvent(listener: (event: PiRuntimeManagerEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  ensureTab(input: { id?: string; sessionFile?: string; title?: string }): RuntimeTab {
    const id = input.id ?? tabId(input.sessionFile);
    let tab = this.tabs.get(id);
    if (!tab) {
      tab = { id, sessionFile: input.sessionFile, title: input.title ?? titleForSession(input.sessionFile), status: "dormant", unread: false, lastActive: Date.now() };
      this.tabs.set(id, tab);
    } else {
      tab.sessionFile = input.sessionFile ?? tab.sessionFile;
      tab.title = input.title ?? tab.title;
    }
    this.runtimeFor(id);
    return tab;
  }

  activate(id: string): RuntimeTab | undefined {
    const tab = this.tabs.get(id);
    if (!tab) return undefined;
    this.currentId = id;
    tab.unread = false;
    tab.lastActive = Date.now();
    return tab;
  }

  async startActive(options: PiRuntimeStartOptions): Promise<boolean> {
    const tab = this.activeTab;
    tab.status = "starting";
    const started = await this.activeRuntime.start(options);
    if (started) tab.status = "ready";
    return started;
  }

  markWorking(runtimeId: string, working: boolean): void {
    const tab = this.tabs.get(runtimeId);
    if (!tab) return;
    tab.status = working ? "working" : "idle";
    if (runtimeId !== this.currentId && !working) tab.unread = true;
  }

  async close(id: string): Promise<void> {
    if (this.tabs.size <= 1) return;
    await this.runtimeFor(id).stop();
    this.unsubscribers.get(id)?.();
    this.unsubscribers.delete(id);
    this.runtimes.delete(id);
    this.tabs.delete(id);
    if (this.currentId === id) this.currentId = this.allTabs[0]?.id ?? "default";
  }

  async suspendIdle(maxActive: number): Promise<void> {
    const running = this.allTabs.filter((tab) => this.runtimes.get(tab.id)?.running);
    const overflow = running
      .filter((tab) => tab.id !== this.currentId && tab.status !== "working")
      .sort((a, b) => a.lastActive - b.lastActive)
      .slice(0, Math.max(0, running.length - maxActive));
    for (const tab of overflow) {
      await this.runtimeFor(tab.id).stop();
      tab.status = "dormant";
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.runtimes.values()).map((runtime) => runtime.stop()));
  }

  setHealth(runtimeId: string, health: RuntimeHealth): void {
    const tab = this.tabs.get(runtimeId);
    if (!tab) return;
    if (health.status === "ready") tab.status = "ready";
    else if (["missing", "incompatible", "error"].includes(health.status)) tab.status = "error";
  }

  private runtimeFor(id: string): PiRuntime {
    let runtime = this.runtimes.get(id);
    if (runtime) return runtime;
    runtime = new PiRuntime((line) => this.log(id, line));
    this.runtimes.set(id, runtime);
    this.unsubscribers.set(id, runtime.onEvent((event) => this.events.emit("event", { ...event, runtimeId: id } satisfies PiRuntimeManagerEvent)));
    return runtime;
  }
}

function tabId(sessionFile?: string): string { return sessionFile ? `session:${sessionFile}` : `tab:${Date.now()}:${Math.random().toString(36).slice(2)}`; }
function titleForSession(sessionFile?: string): string { return sessionFile ? basename(sessionFile).replace(/\.jsonl$/i, "") : "New session"; }
