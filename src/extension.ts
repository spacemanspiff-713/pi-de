import * as vscode from "vscode";
import { PiViewProvider } from "./piViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("PiDE", { log: true });
  const provider = new PiViewProvider(context, output);

  context.subscriptions.push(
    output,
    provider,
    vscode.window.registerWebviewViewProvider(PiViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider("pide-change", provider),
    vscode.commands.registerCommand("pide.openChat", () => provider.reveal()),
    vscode.commands.registerCommand("pide.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("pide.openSession", () => provider.openSession()),
    vscode.commands.registerCommand("pide.openControlCenter", () => provider.openControlCenter()),
    vscode.commands.registerCommand("pide.reviewChanges", () => provider.reviewChanges()),
    vscode.commands.registerCommand("pide.abort", () => provider.abort()),
    vscode.commands.registerCommand("pide.restart", () => provider.restart()),
    vscode.commands.registerCommand("pide.askSelection", async () => {
      await provider.reveal();
      provider.prefillForSelection();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void provider.restart();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("pide.executablePath")
        && !event.affectsConfiguration("pide.extraArgs")
        && !event.affectsConfiguration("pide.approveTrustedWorkspace")) return;
      void vscode.window.showInformationMessage(
        "PiDE configuration changed. Restart the Pi runtime to apply it.",
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
