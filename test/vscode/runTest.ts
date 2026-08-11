import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = resolve(__dirname, "../../..");
  const extensionTestsPath = resolve(__dirname, "suite", "index.js");
  const cachePath = process.env.PI_VSCODE_TEST_CACHE ?? join(homedir(), ".cache", "pide", "vscode-test");
  await mkdir(cachePath, { recursive: true });
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    cachePath,
    launchArgs: ["--disable-extensions", "--skip-welcome", "--skip-release-notes"],
  });
}

void main().catch((error) => {
  console.error("VS Code integration tests failed", error);
  process.exitCode = 1;
});
