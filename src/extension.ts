import * as vscode from "vscode";
import { PiViewProvider } from "./piViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Pi Coding Agent", { log: true });
  const provider = new PiViewProvider(context, output);

  context.subscriptions.push(
    output,
    provider,
    vscode.window.registerWebviewViewProvider(PiViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider("pi-change", provider),
    vscode.commands.registerCommand("pi.openChat", () => provider.reveal()),
    vscode.commands.registerCommand("pi.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("pi.openSession", () => provider.openSession()),
    vscode.commands.registerCommand("pi.reviewChanges", () => provider.reviewChanges()),
    vscode.commands.registerCommand("pi.abort", () => provider.abort()),
    vscode.commands.registerCommand("pi.restart", () => provider.restart()),
    vscode.commands.registerCommand("pi.askSelection", async () => {
      await provider.reveal();
      provider.prefillForSelection();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void provider.restart();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("pi.executablePath")
        && !event.affectsConfiguration("pi.extraArgs")
        && !event.affectsConfiguration("pi.approveTrustedWorkspace")) return;
      void vscode.window.showInformationMessage(
        "Pi configuration changed. Restart the Pi agent to apply it.",
        "Restart",
      ).then((choice) => {
        if (choice === "Restart") void provider.restart();
      });
    }),
  );
}

export function deactivate(): void {
  // PiViewProvider is disposed through ExtensionContext subscriptions.
}
