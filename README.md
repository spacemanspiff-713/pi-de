# PiDE — Pi Development Environment

![PiDE](assets/PiDE.jpg)

A dedicated, independent VS Code development environment powered by the real [Pi coding agent](https://pi.dev).

PiDE gives Pi a first-class home in the editor: streaming conversations, native change review, searchable sessions, rich context attachments, and MCP controls—without replacing Pi's runtime or creating a separate configuration silo.

> **Vibe coded with Pi, for Pi.** Every commit in this repo was produced by a Pi coding agent working inside its own PiDE interface. The primary model was `openai-codex/gpt-5.5` with thinking on medium, assisted by `openrouter/deepseek/deepseek-v4-pro` & local `gemma-4-26b-a4b` for faster iteration. Also used `openai-codex/gpt-5.6 Terra ` for architecture review and planning. Pi literally built its own home.

> **Project status:** Early open-source release. v0.10.0 is usable today, but interfaces and configuration may change while the project moves toward a stable release.

## 🙏 Shoutout

PiDE learned a tremendous amount from two pioneering Pi-in-VS-Code experiments:

- **[`auchan/pi-on-code`](https://github.com/auchan/pi-on-code)** — a VS Code extension that embeds a real Pi agent with streaming chat, session switching, and inline code actions. Its clean provider/webview split, `@`-mention system, and diff-review UX were direct design references.
- **[`JohnnyZ93/pi-agent-studio`](https://github.com/JohnnyZ93/pi-agent-studio)** — a polished multi-tool studio that demonstrated resource panels, extension UI bridging, package management, and the potential of a richer sidecar architecture.

Both are MIT licensed and worth studying. This project builds on their patterns while keeping a focused, stable RPC-sidecar core.

## Why this project exists

Pi already provides a capable coding-agent runtime, package ecosystem, extension system, session format, and MCP integration. This project focuses on the missing editor experience.

The extension deliberately does **not** implement another agent loop. It launches:

```text
pi --mode rpc
```

and translates Pi's RPC stream into native VS Code workflows. Your existing Pi setup remains the source of truth.

## Highlights

### Dedicated PiDE workspace

- Independent **PiDE** Activity Bar view
- Streaming assistant text and reasoning
- Sanitized Markdown, tables, links, and syntax highlighting
- Expandable tool cards with state and output
- Copy and Insert actions for code blocks
- Queued follow-ups and cancellation
- Pi model and thinking-level selectors
- Dynamic slash commands from Pi extensions, skills, prompt templates, and MCP prompts
- Capability-based Pi discovery with actionable runtime-health and Workspace Trust guidance

### Rich editor context

Type `@` in the composer to attach:

- current selection;
- current file;
- open files;
- diagnostics/problems;
- Git diff;
- terminal metadata;
- workspace roots;
- any matching workspace file.

Attachments are visible as removable chips and are bounded before being sent to Pi.

### Native change review

Before each ordinary Pi task, the extension captures the current Git working tree using a temporary index and a private checkpoint ref.

After Pi settles, you can:

- see changed-file and line totals;
- open native VS Code before/after diffs;
- accept an individual file as reviewed;
- revert an individual file to its exact pre-task content;
- review all files from the latest task.

The checkpoint preserves work that was already dirty, staged, or untracked before Pi started. Revert means “restore the state immediately before this Pi task,” not “reset to `HEAD`.” The real Git index is not modified while the checkpoint is captured.

### Searchable Pi session library

The session browser reads Pi's existing JSONL session store. For the current workspace it can:

- search names and bounded user-message history;
- show timestamps, model, messages, tool calls, tokens, and cost;
- resume and rename sessions;
- clone or fork from a historical user message;
- archive and restore sessions;
- move sessions to the operating-system trash.

The extension does not introduce a proprietary conversation format.

### MCP control center

The MCP drawer consumes status from the existing [`pi-mcp-adapter`](https://www.npmjs.com/package/pi-mcp-adapter) loaded by Pi.

It supports:

- server status;
- tool and resource counts;
- connect/reconnect;
- reconnect all;
- enable/disable;
- OAuth handoff;
- MCP prompt shortcuts;
- existing Pi approval flows;
- opening or creating MCP configuration.

Pi continues to own MCP discovery and tool execution.

### Runtime and resource control center

PiDE's control center reports the active Pi binary, version, agent directory, and session directory. It also manages the package list through Pi's own CLI and opens or creates user/project extensions, skills, prompt templates, and agent definitions. Project-local resource changes require an explicit trust warning and restart Pi when necessary.

### Pi extension UI

Pi extension requests are bridged into VS Code for:

- notifications;
- confirmation;
- selection;
- text input;
- editor input;
- external links.

### Agent Lab

PiDE v0.10 presents Agent Lab as a Chat / Swarm management board with an auto-hiding live swarm strip, compact run cards, and a selected-run artifact inspector. Cards stay scannable; the inspector holds the full result, source/citation cards, tool traces, worktree review, and audit trail. Role selections survive telemetry updates, and background agents no longer force the Swarm view open. PiDE also includes Agent Lab control and observability. Built-in roles can be opened as editable Markdown overrides, including model, tools, skills, invocation, mode, tool-call cap, and duration cap. Read-only research roles run in isolated temporary Pi sidecars with exact tool allowlists and live telemetry. The `Implementer` is the sole coding role: it receives a dedicated Git branch/worktree, can use only `read`, `edit`, and `write` against paths inside that worktree, and returns a retained change set for review. PiDE can run configured validation in the worktree, open native VS Code diffs, apply only selected file patches, or—after a modal confirmation and merge-conflict preflight—merge the agent branch. The primary workspace is never given to a coding agent.

Example role override:

```md
---
id: researcher
name: Researcher
description: Official-docs-first web researcher
model: openrouter/deepseek/deepseek-v4-pro
tools: web_fetch brave_search
skills: docs-search
invocation: manual
mode: read-only
maxToolCalls: 10
maxDurationMinutes: 4
---

Prefer official documentation and primary sources. Return 3-6 cited links, key findings, uncertainty, and recommended next steps.
```

## Requirements

- VS Code 1.100 or newer
- Node.js 22 or newer for development
- Pi installed and configured on the workspace machine
- A trusted local or remote workspace

Install Pi if needed:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Verify it:

```bash
pi --version
```

For Remote SSH, WSL, or development containers, install and configure Pi in that remote workspace environment. This extension runs as a VS Code workspace extension.

## Current limitations

- PiDE can keep multiple session tabs open with lazily-started Pi RPC sidecars. Idle background runtimes may be suspended when `pide.maxActiveRuntimes` is exceeded.
- Native checkpoint review requires a Git worktree. Chat and sessions still work outside Git repositories.
- The MCP control center expects `pi-mcp-adapter` to be configured through Pi.
- Agent Lab role overrides are Markdown files under `~/.pi/agent/agents/*.md` or `<project>/.pi/agents/*.md`; malformed or over-broad custom tool policies can still waste tokens, so keep caps low and roles focused.
- The extension is currently distributed as a locally built VSIX rather than through the Marketplace.

## Installation

The project is not yet published to the VS Code Marketplace. Build and install a VSIX from source:

```bash
git clone https://github.com/spacemanspiff-713/pi-de.git
cd pi-de
npm install
npm run package
code --install-extension pide-0.10.0.vsix --force
```

Then run **Developer: Reload Window** in VS Code.

> **Upgrading from the pre-PiDE build?** The extension identifier changed from `spacemanspiff-713.pi-vscode` to `spacemanspiff-713.pide`. Remove the legacy local extension before installing PiDE so only one Pi sidecar can start:
>
> ```bash
> code --uninstall-extension spacemanspiff-713.pi-vscode
> ```

Alternatively, press `F5` from the repository to launch an Extension Development Host.

## Getting started

1. Open a trusted folder in VS Code.
2. Select the **PiDE** icon in the Activity Bar.
3. Optionally move the PiDE view to the Secondary Side Bar.
4. Send a prompt.
5. Type `@` to attach editor/workspace context.
6. Type `/` to browse commands exposed by your Pi runtime.

The header provides shortcuts for:

- session library;
- change review;
- MCP control center;
- new session;
- restart;
- output logs.

## Commands

| Command | Purpose |
| --- | --- |
| `PiDE: Open Chat` | Reveal and focus the PiDE view |
| `PiDE: New Session` | Start a new Pi session |
| `PiDE: Open Session` | Open the searchable session library |
| `PiDE: Review Changes` | Review the latest Pi task's file changes |
| `PiDE: Stop Agent` | Abort active Pi work |
| `PiDE: Restart Agent` | Restart the Pi RPC sidecar |
| `PiDE: Ask Pi About Selection` | Open PiDE with the current editor selection attached |

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `pide.executablePath` | `pi` | Pi executable used for RPC mode |
| `pide.extraArgs` | `[]` | Additional arguments passed to Pi |
| `pide.approveTrustedWorkspace` | `true` | Pass Pi project-resource approval after VS Code trust is granted |
| `pide.showThinking` | `true` | Display streamed reasoning in collapsible blocks |
| `pide.gitCheckpoints` | `true` | Capture a non-destructive pre-task Git checkpoint for review/revert |
| `pide.maxActiveRuntimes` | `3` | Maximum active Pi sidecars before idle session tabs are suspended |
| `pide.agentLabMaxConcurrent` | `4` | Maximum Agent Lab subagents that can run concurrently |
| `pide.agentLabTokenBudget` | `12000` | Soft per-subagent token budget included in the safety prompt |
| `pide.agentLabValidationCommand` | `npm test` | Validation command run only in coding-agent worktrees |
| `pide.agentLabMaxToolCalls` | `24` | Default maximum tool calls per Agent Lab run unless a role override sets `maxToolCalls` |
| `pide.agentLabMaxDurationMinutes` | `5` | Default maximum run duration unless a role override sets `maxDurationMinutes` |

Your models, providers, API credentials, Pi extensions, skills, prompt templates, sessions, and MCP configuration remain in Pi's normal configuration directories.

## Architecture

```text
┌──────────────────────────────────────────────────────┐
│ VS Code extension host                               │
│                                                      │
│  PiViewProvider ── typed protocol / context / UI      │
│        │                                             │
│        │ JSONL RPC                                   │
│        ▼                                             │
│  pi --mode rpc --extension pi-bridge/index.ts        │
│        │                                             │
│        ├── Pi models and credentials                 │
│        ├── Pi tools and extensions                   │
│        ├── Pi JSONL sessions                         │
│        └── pi-mcp-adapter                            │
│                                                      │
│  Webview TS modules ◀── typed, bounded messages      │
└──────────────────────────────────────────────────────┘
```

Important principles:

- Pi is the agent and runtime.
- VS Code is the presentation and editor-integration layer.
- JSONL session files remain portable between CLI and extension.
- Credentials never need to be copied into the webview.
- MCP is not reimplemented in the extension.

See [AGENTS.md](AGENTS.md) for contributor architecture rules and [GAMEPLAN.md](GAMEPLAN.md) for completed work and the full roadmap.

## Development

Install dependencies:

```bash
npm install
```

Run the complete check:

```bash
npm run check
```

Useful commands:

```bash
npm run compile        # TypeScript and webview bundle
npm run build:webview  # Regenerate media/main.js
npm test               # Run Vitest
npm run package        # Validate and create a VSIX
```

### Source map

```text
src/extension.ts                     VS Code activation and commands
src/piViewProvider.ts                View composition, context, and RPC event translation
src/protocol.ts                      Shared typed host/webview protocol
src/runtime/piRuntime.ts             Runtime ownership and central event stream
src/runtime/piCapabilities.ts        Capability-based Pi runtime probing
src/runtime/piExecutable.ts          Cross-platform Pi executable discovery
src/controllers/sessionController.ts Session UI/actions and persistence
src/controllers/changeReviewController.ts Git review orchestration
src/controllers/mcpController.ts     MCP status and command controls
src/controllers/extensionUiBridge.ts Pi extension UI routing
src/piRpcClient.ts                   Pi sidecar JSONL transport
src/contextMentions.ts               @context parsing and bounds
src/changeReview.ts                  Git checkpoints and file restoration
src/sessionLibrary.ts                Pi JSONL session indexing
pi-bridge/index.ts                   Pi-to-VS Code MCP status bridge
webview/main.ts                      Typed webview entry point
webview/runtimeHealth.ts             Runtime onboarding UI
media/main.css                       Webview styling
```

Do not edit `media/main.js` directly; it is generated from the TypeScript modules under `webview/`.

## Testing

The current suite covers:

- incremental JSONL decoding;
- context mention parsing;
- dirty/staged/untracked Git checkpoint safety;
- exact per-file restoration;
- session JSONL metadata and archive behavior;
- webview Markdown, links, runtime onboarding, change review, and MCP rendering;
- recorded Pi RPC and CLI capability contracts;
- executable discovery and typed webview-message validation;
- VS Code Extension Host activation, command, and workspace-capability behavior.

Changes to runtime startup, Pi RPC events, packaging, or `pi-bridge` should also be smoke-tested against a real Pi installation.

## Security and privacy

This extension controls a coding agent capable of reading and modifying files and running commands.

- Only use it in workspaces you trust.
- Review `AGENTS.md`, project `.pi` resources, and installed Pi extensions.
- Prompts, attachments, and tool results are sent to the model provider configured in Pi.
- The extension does not add a second credential store.
- Credentials are not intentionally sent to the webview.
- Context and rendered tool output are bounded and sanitized.
- Git checkpoints are recovery aids, not a substitute for normal commits and backups.

Please do not include API keys, OAuth tokens, proprietary session transcripts, or private source code in public bug reports.

## Roadmap

Near-term work includes:

1. Session export, pinning, compact/reload actions, and richer runtime status
2. Package, extension, skill, prompt, and agent resource management
3. A bounded read-only VS Code diagnostics/symbol bridge
4. Persistent multi-session tabs and background sessions
5. Read-only research agents and Git-worktree-isolated coding agents
6. Git-worktree-isolated coding agents with native diff review

The detailed checklist is maintained in [GAMEPLAN.md](GAMEPLAN.md). Phase 5B chat-window/swarm-board UI discovery is documented in [UI.md](UI.md). Third-party design references and dependency notices are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Inspiration and attribution

See the [Shoutout](#-shoutout) near the top of this README. Both reference projects are MIT licensed. This project maintains its own RPC-sidecar implementation and selectively learns from patterns demonstrated across the ecosystem. Any future direct code adaptation must preserve the relevant copyright and license notices.

## Contributing

Contributions are welcome.

Before opening a pull request:

1. Read [AGENTS.md](AGENTS.md).
2. Keep the change focused.
3. Add or update tests.
4. Run `npm run check`.
5. Run `git diff --check`.
6. Update documentation for user-visible behavior.

Security-sensitive features—package installation, credentials, editor mutation, concurrent runtimes, and subagents—should begin with a design discussion.

## License

[MIT](LICENSE) © 2026 PiDaddy Labs

## Project relationship

PiDE is a community-built development environment for Pi. It is not an official Pi or VS Code product and is not affiliated with GitHub Copilot.
