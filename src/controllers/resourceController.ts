import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { RuntimeHealth } from "../protocol";
import { resolvePiExecutable } from "../runtime/piExecutable";

const execFileAsync = promisify(execFile);
type ResourceKind = "extensions" | "skills" | "prompts" | "agents";
type Scope = "user" | "project";

interface ResourceFile {
  path: string;
  label: string;
  scope: Scope;
}

export class ResourceController {
  constructor(
    private readonly workspaceFolder: () => vscode.WorkspaceFolder | undefined,
    private readonly health: () => RuntimeHealth | undefined,
    private readonly restart: () => Promise<void>,
    private readonly output: vscode.OutputChannel,
  ) {}

  async open(): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      { label: "$(pulse) Runtime details", value: "runtime", description: "Pi binary, version, agent and session directories" },
      { label: "$(package) Packages", value: "packages", description: "List, install, remove, or update Pi packages" },
      { label: "$(extensions) Extensions", value: "extensions", description: "Open loaded extension files" },
      { label: "$(symbol-method) Skills", value: "skills", description: "Manage user or trusted project skills" },
      { label: "$(file-code) Prompt templates", value: "prompts", description: "Manage user or trusted project prompts" },
      { label: "$(hubot) Agent definitions", value: "agents", description: "Manage user or trusted project agents" },
    ], { title: "PiDE Control Center", placeHolder: "Choose a Pi runtime or resource action" });
    if (!selected) return;
    if (selected.value === "runtime") return this.showRuntime();
    if (selected.value === "packages") return this.managePackages();
    return this.manageFiles(selected.value as ResourceKind);
  }

  private async showRuntime(): Promise<void> {
    const health = this.health();
    const agentDir = agentDirectory();
    const sessionDir = sessionDirectory(agentDir);
    const lines = [
      `Status: ${health?.status ?? "not started"}`,
      `Pi: ${health?.version ?? "unknown"}`,
      `Binary: ${health?.executable ?? vscode.workspace.getConfiguration("pide").get<string>("executablePath", "pi")}`,
      `Agent directory: ${agentDir}`,
      `Session directory: ${sessionDir}`,
    ];
    this.output.appendLine(`[PiDE runtime]\n${lines.join("\n")}`);
    const action = await vscode.window.showInformationMessage(lines.join("\n"), "Show Output", "Open Settings");
    if (action === "Show Output") this.output.show(true);
    if (action === "Open Settings") await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:spacemanspiff-713.pide");
  }

  private async managePackages(): Promise<void> {
    const entries = [
      ...await packagesIn(agentDirectory(), "user"),
      ...await packagesIn(projectPiDirectory(this.workspaceFolder()), "project"),
    ];
    const selected = await vscode.window.showQuickPick([
      { label: "$(add) Install package", value: "install", description: "Runs pi install" },
      { label: "$(sync) Update extensions", value: "update", description: "Runs pi update --extensions" },
      ...entries.map((entry) => ({
        label: entry.value,
        description: `${entry.scope} scope`,
        detail: "Select to remove this package",
        value: `remove:${entry.scope}:${entry.value}`,
      })),
    ], { title: "PiDE Packages", placeHolder: "Configured packages; select one to remove it" });
    if (!selected) return;
    if (selected.value === "install") {
      const source = await vscode.window.showInputBox({ title: "Install Pi package", prompt: "npm:, git:, URL, or local package source" });
      if (!source?.trim()) return;
      const scope = await this.pickScope("Install this package in");
      if (!scope || !await this.confirmProjectScope(scope)) return;
      await this.runPi(["install", source.trim(), ...(scope === "project" ? ["--local", "--approve"] : [])]);
      await this.restart();
      return;
    }
    if (selected.value === "update") {
      await this.runPi(["update", "--extensions"]);
      await this.restart();
      return;
    }
    // A package source can itself contain colons, so derive scope/source from the known prefix.
    const match = /^remove:(user|project):(.*)$/.exec(selected.value);
    if (!match || !await this.confirmProjectScope(match[1] as Scope)) return;
    const confirmed = await vscode.window.showWarningMessage(`Remove Pi package “${match[2]}”?`, { modal: true }, "Remove");
    if (confirmed !== "Remove") return;
    await this.runPi(["remove", match[2], ...(match[1] === "project" ? ["--local", "--approve"] : [])]);
    await this.restart();
  }

  private async manageFiles(kind: ResourceKind): Promise<void> {
    const resources = await discoverResources(kind, this.workspaceFolder());
    const selected = await vscode.window.showQuickPick([
      { label: "$(new-file) Create resource", value: "create", description: `Create a ${kind.slice(0, -1)} in user or project scope` },
      ...resources.map((resource) => ({ label: resource.label, description: `${resource.scope} scope`, detail: resource.path, value: resource.path })),
    ], { title: `PiDE ${title(kind)}`, placeHolder: "Select a file to manage" });
    if (!selected) return;
    if (selected.value === "create") return this.createResource(kind);
    const resource = resources.find((entry) => entry.path === selected.value);
    if (!resource) return;
    const action = await vscode.window.showQuickPick(["Open", "Rename", "Delete"], { title: `${title(kind)}: ${resource.label}` });
    if (!action) return;
    if (action === "Open") return void vscode.window.showTextDocument(vscode.Uri.file(resource.path));
    if (!await this.confirmProjectScope(resource.scope)) return;
    if (action === "Rename") {
      const name = await this.resourceName(kind, basename(resource.path, ".md"));
      if (!name) return;
      await rename(resource.path, join(dirname(resource.path), `${name}.md`));
    } else {
      const confirmed = await vscode.window.showWarningMessage(`Delete ${resource.label}?`, { modal: true }, "Delete");
      if (confirmed === "Delete") await vscode.workspace.fs.delete(vscode.Uri.file(resource.path), { useTrash: true });
    }
    await this.restart();
  }

  private async createResource(kind: ResourceKind): Promise<void> {
    const scope = await this.pickScope(`Create ${kind.slice(0, -1)} in`);
    if (!scope || !await this.confirmProjectScope(scope)) return;
    const name = await this.resourceName(kind);
    if (!name) return;
    const root = scope === "user" ? agentDirectory() : projectPiDirectory(this.workspaceFolder());
    if (!root) return;
    const path = join(root, kind, `${name}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, defaultResource(kind, name), { encoding: "utf8", flag: "wx" });
    await vscode.window.showTextDocument(vscode.Uri.file(path));
    await this.restart();
  }

  private async resourceName(kind: ResourceKind, value = ""): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({ title: `PiDE ${title(kind)}`, value, prompt: "Letters, numbers, hyphens, underscores, and dots only" });
    return name && /^[A-Za-z0-9._-]+$/.test(name) ? name : undefined;
  }

  private async pickScope(titleText: string): Promise<Scope | undefined> {
    const choices: Array<{ label: string; value: Scope; description: string }> = [{ label: "User", value: "user", description: agentDirectory() }];
    const folder = this.workspaceFolder();
    if (folder) choices.push({ label: "Project", value: "project", description: projectPiDirectory(folder) ?? "" });
    return (await vscode.window.showQuickPick(choices, { title: titleText }))?.value;
  }

  private async confirmProjectScope(scope: Scope): Promise<boolean> {
    if (scope === "user") return true;
    return (await vscode.window.showWarningMessage(
      "Project-local Pi resources are trusted executable instructions. Only modify them in a workspace you trust.",
      { modal: true },
      "I Trust This Project",
    )) === "I Trust This Project";
  }

  private async runPi(args: string[]): Promise<void> {
    const configured = vscode.workspace.getConfiguration("pide").get<string>("executablePath", "pi");
    const executable = await resolvePiExecutable({ configured });
    this.output.appendLine(`[PiDE package] ${executable} ${args.join(" ")}`);
    await execFileAsync(executable, args, { cwd: this.workspaceFolder()?.uri.fsPath, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  }
}

async function packagesIn(root: string | undefined, scope: Scope): Promise<Array<{ value: string; scope: Scope }>> {
  if (!root) return [];
  try {
    const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as { packages?: unknown };
    return Array.isArray(settings.packages) ? settings.packages.filter((value): value is string => typeof value === "string").map((value) => ({ value, scope })) : [];
  } catch { return []; }
}

async function discoverResources(kind: ResourceKind, folder: vscode.WorkspaceFolder | undefined): Promise<ResourceFile[]> {
  const roots: Array<{ path?: string; scope: Scope }> = [{ path: agentDirectory(), scope: "user" }, { path: projectPiDirectory(folder), scope: "project" }];
  const resources: ResourceFile[] = [];
  for (const root of roots) {
    if (!root.path) continue;
    const directory = join(root.path, kind);
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      resources.push(...entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => ({ path: join(directory, entry.name), label: relative(directory, join(directory, entry.name)).replace(/\.md$/, ""), scope: root.scope })));
    } catch { /* resource directory is optional */ }
  }
  return resources.sort((a, b) => a.scope.localeCompare(b.scope) || a.label.localeCompare(b.label));
}

function agentDirectory(): string { return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"); }
function sessionDirectory(agentDir: string): string { return process.env.PI_CODING_AGENT_SESSION_DIR ?? join(agentDir, "sessions"); }
function projectPiDirectory(folder: vscode.WorkspaceFolder | undefined): string | undefined { return folder ? join(folder.uri.fsPath, ".pi") : undefined; }
function title(kind: ResourceKind): string { return kind === "prompts" ? "Prompt Templates" : `${kind[0].toUpperCase()}${kind.slice(1)}`; }
function defaultResource(kind: ResourceKind, name: string): string { return kind === "agents" ? `---\nname: ${name}\ndescription: TODO\n---\n\n# ${name}\n` : `# ${name}\n\nDescribe this ${kind.slice(0, -1)}.\n`; }
