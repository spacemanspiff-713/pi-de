import * as vscode from "vscode";

const MAX_TEXT = 12_000;
const MAX_ITEMS = 40;

export type ContextAction = "selection" | "diagnostics" | "editors" | "symbols" | "definitions" | "references" | "hover";

export class VscodeContextController {
  async request(raw: unknown): Promise<string> {
    const request = asRecord(raw);
    const action = isAction(request.action) ? request.action : "selection";
    const query = typeof request.query === "string" ? request.query.slice(0, 512) : "";
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    const position = editor?.selection.active;

    switch (action) {
      case "selection": return json({ action, editor: editorState(editor), selection: bounded(editor?.document.getText(editor.selection) ?? "") });
      case "diagnostics": return json({ action, diagnostics: vscode.languages.getDiagnostics().flatMap(([file, diagnostics]) => diagnostics.slice(0, MAX_ITEMS).map((item) => ({ file: relative(file), severity: vscode.DiagnosticSeverity[item.severity], message: bounded(item.message, 1_000), range: range(item.range) }))).slice(0, MAX_ITEMS) });
      case "editors": return json({ action, editors: vscode.window.visibleTextEditors.slice(0, MAX_ITEMS).map(editorState) });
      case "symbols": return json({ action, symbols: await this.symbols(uri, query) });
      case "definitions": return json({ action, definitions: uri && position ? await locations("vscode.executeDefinitionProvider", uri, position) : [] });
      case "references": return json({ action, references: uri && position ? await locations("vscode.executeReferenceProvider", uri, position) : [] });
      case "hover": return json({ action, hover: uri && position ? await this.hover(uri, position) : undefined });
    }
  }

  private async symbols(uri: vscode.Uri | undefined, query: string): Promise<unknown[]> {
    if (query) {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", query);
      return (symbols ?? []).slice(0, MAX_ITEMS).map((symbol) => ({ name: symbol.name, kind: vscode.SymbolKind[symbol.kind], file: relative(symbol.location.uri), range: range(symbol.location.range), container: symbol.containerName }));
    }
    if (!uri) return [];
    const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>("vscode.executeDocumentSymbolProvider", uri);
    return flattenSymbols(symbols ?? []).slice(0, MAX_ITEMS);
  }

  private async hover(uri: vscode.Uri, position: vscode.Position): Promise<unknown> {
    const values = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, position);
    return values?.[0] ? { contents: values[0].contents.map((item) => typeof item === "string" ? bounded(item, 2_000) : bounded(item.value, 2_000)), range: values[0].range ? range(values[0].range) : undefined } : undefined;
  }
}

async function locations(command: string, uri: vscode.Uri, position: vscode.Position): Promise<unknown[]> {
  const values = await vscode.commands.executeCommand<vscode.Location[]>(command, uri, position);
  return (values ?? []).slice(0, MAX_ITEMS).map((location) => ({ file: relative(location.uri), range: range(location.range) }));
}
function flattenSymbols(values: Array<vscode.DocumentSymbol | vscode.SymbolInformation>, parent = ""): unknown[] { return values.flatMap((symbol) => "location" in symbol ? [{ name: symbol.name, kind: vscode.SymbolKind[symbol.kind], file: relative(symbol.location.uri), range: range(symbol.location.range), container: symbol.containerName }] : [{ name: symbol.name, kind: vscode.SymbolKind[symbol.kind], range: range(symbol.range), container: parent }, ...flattenSymbols(symbol.children, symbol.name)]); }
function editorState(editor: vscode.TextEditor | undefined): unknown { return editor ? { file: relative(editor.document.uri), language: editor.document.languageId, selection: range(editor.selection) } : undefined; }
function range(value: vscode.Range): unknown { return { start: { line: value.start.line, character: value.start.character }, end: { line: value.end.line, character: value.end.character } }; }
function relative(uri: vscode.Uri): string { return vscode.workspace.asRelativePath(uri, false); }
function bounded(value: string, max = MAX_TEXT): string { return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function isAction(value: unknown): value is ContextAction { return ["selection", "diagnostics", "editors", "symbols", "definitions", "references", "hover"].includes(String(value)); }
function json(value: unknown): string { const text = JSON.stringify(value); return bounded(text, 24_000); }
