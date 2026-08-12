import * as assert from "node:assert/strict";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  await activatesAndRegistersCommands();
  declaresWorkspaceRequirements();
  declaresPiDEBranding();
  console.log("PiDE Extension Host integration tests: 3 passed");
}

async function activatesAndRegistersCommands(): Promise<void> {
  const extension = vscode.extensions.getExtension("pidaddylabs.pide");
  assert.ok(extension, "The PiDE extension should be present in the development host");
  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "pide.openChat",
    "pide.newSession",
    "pide.openSession",
    "pide.openControlCenter",
    "pide.openAgentLab",
    "pide.reviewChanges",
    "pide.abort",
    "pide.restart",
    "pide.askSelection",
  ]) {
    assert.ok(commands.includes(command), `${command} should be registered`);
  }
}

function declaresWorkspaceRequirements(): void {
  const manifest = manifestForPiDE();
  assert.equal(manifest.capabilities?.untrustedWorkspaces?.supported, false);
  assert.equal(manifest.capabilities?.virtualWorkspaces?.supported, false);
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
}

function declaresPiDEBranding(): void {
  const manifest = manifestForPiDE();
  assert.equal(manifest.name, "pide");
  assert.equal(manifest.displayName, "PiDE");
  assert.equal(manifest.icon, "assets/PiDE.jpg");
  assert.equal(manifest.contributes?.viewsContainers?.activitybar?.[0]?.icon, "assets/PiDE.jpg");
}

function manifestForPiDE(): Record<string, any> {
  const extension = vscode.extensions.getExtension("pidaddylabs.pide");
  assert.ok(extension, "The PiDE extension should be present in the development host");
  return extension.packageJSON as Record<string, any>;
}
