import { resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = resolve(__dirname, "../../..");
  const extensionTestsPath = resolve(__dirname, "suite", "index.js");
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ["--disable-extensions", "--skip-welcome", "--skip-release-notes"],
  });
}

void main().catch((error) => {
  console.error("VS Code integration tests failed", error);
  process.exitCode = 1;
});
