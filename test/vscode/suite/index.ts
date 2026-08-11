import * as assert from "node:assert/strict";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  await activatesAndRegistersCommands();
  declaresWorkspaceRequirements();
  console.log("Pi Extension Host integration tests: 2 passed");
}

async function activatesAndRegistersCommands(): Promise<void> {
  const extension = vscode.extensions.getExtension("pidaddylabs.pi-vscode");
  assert.ok(extension, "The Pi extension should be present in the development host");
  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "pi.openChat",
    "pi.newSession",
    "pi.openSession",
    "pi.reviewChanges",
    "pi.abort",
    "pi.restart",
    "pi.askSelection",
  ]) {
    assert.ok(commands.includes(command), `${command} should be registered`);
  }
}

function declaresWorkspaceRequirements(): void {
  const extension = vscode.extensions.getExtension("pidaddylabs.pi-vscode");
  const manifest = extension?.packageJSON as Record<string, any>;
  assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, false);
  assert.equal(manifest.capabilities?.virtualWorkspaces?.supported, false);
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
}
