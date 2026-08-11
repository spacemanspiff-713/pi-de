import * as vscode from "vscode";
import { GitChangeReview, type ChangeSet } from "../changeReview";

export class ChangeReviewController implements vscode.TextDocumentContentProvider {
  private readonly review: GitChangeReview;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly workspaceFolder: () => vscode.WorkspaceFolder | undefined,
  ) {
    this.review = new GitChangeReview((line) => output.appendLine(`[Git checkpoint] ${line}`));
  }

  get changeSet(): ChangeSet | undefined {
    return this.review.changeSet;
  }

  async restore(): Promise<ChangeSet | undefined> {
    const folder = this.workspaceFolder();
    if (!folder) return undefined;
    const stored = this.context.workspaceState.get<ChangeSet>(this.storageKey(folder.uri));
    this.review.restore(stored);
    return stored;
  }

  async begin(prompt: string): Promise<void> {
    const folder = this.workspaceFolder();
    if (!folder) return;
    await this.review.begin(folder.uri.fsPath, prompt);
  }

  async finish(): Promise<ChangeSet | undefined> {
    const changeSet = await this.review.finish();
    if (changeSet) await this.persist(changeSet);
    return changeSet;
  }

  async accept(path: string): Promise<ChangeSet | undefined> {
    const changeSet = this.review.accept(path);
    if (changeSet) await this.persist(changeSet);
    return changeSet;
  }

  async revert(path: string): Promise<ChangeSet | undefined> {
    const changeSet = await this.review.revert(path);
    if (changeSet) await this.persist(changeSet);
    return changeSet;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const path = params.get("path") ?? uri.path.replace(/^\//, "");
    return params.get("side") === "before"
      ? await this.review.beforeContent(path)
      : await this.review.afterContent(path);
  }

  async openDiff(path: string): Promise<void> {
    const changeSet = this.review.changeSet;
    if (!changeSet || !changeSet.files.some((file) => file.path === path)) return;
    const revision = `${changeSet.id}-${Date.now()}`;
    const uriPath = `/${path.replace(/^\//, "")}`;
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.from({
        scheme: "pide-change",
        path: uriPath,
        query: new URLSearchParams({ side: "before", path, revision }).toString(),
      }),
      vscode.Uri.from({
        scheme: "pide-change",
        path: uriPath,
        query: new URLSearchParams({ side: "after", path, revision }).toString(),
      }),
      `${path} — Before Pi ↔ After Pi`,
      { preview: true },
    );
  }

  private storageKey(uri: vscode.Uri): string {
    return `pi.latestChangeSet:${uri.toString()}`;
  }

  private async persist(changeSet: ChangeSet): Promise<void> {
    const folder = this.workspaceFolder();
    if (folder) await this.context.workspaceState.update(this.storageKey(folder.uri), changeSet);
  }
}
