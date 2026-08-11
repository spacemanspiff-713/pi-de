import type { RuntimeHealth } from "../src/protocol";

export interface RuntimeHealthElements {
  container: HTMLElement;
  title: HTMLElement;
  message: HTMLElement;
  details: HTMLElement;
  trustButton: HTMLButtonElement;
}

export function renderRuntimeHealth(elements: RuntimeHealthElements, health: RuntimeHealth): void {
  const available = health.status === "ready";
  elements.container.classList.toggle("hidden", available);
  elements.title.textContent = titleFor(health.status);
  elements.message.textContent = health.message;
  elements.details.textContent = [
    health.executable ? `Executable: ${health.executable}` : "",
    health.version ? `Version: ${health.version}` : "",
  ].filter(Boolean).join(" · ");
  elements.trustButton.classList.toggle("hidden", health.status !== "untrusted");
}

function titleFor(status: RuntimeHealth["status"]): string {
  switch (status) {
    case "checking": return "Checking Pi runtime";
    case "missing": return "Pi is not installed or could not be found";
    case "incompatible": return "Pi needs to be updated";
    case "untrusted": return "Workspace Trust is required";
    case "no-workspace": return "Open a workspace";
    case "error": return "Pi runtime check failed";
    case "ready": return "Pi runtime ready";
  }
}
