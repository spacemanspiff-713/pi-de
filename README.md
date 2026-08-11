# Pi Coding Agent for VS Code

A dedicated, independent VS Code interface powered by the real [Pi coding agent](https://pi.dev).

Pi Coding Agent for VS Code gives Pi a first-class home in the editor: streaming conversations, native change review, searchable sessions, rich context attachments, and MCP controls—without replacing Pi's runtime or creating a separate configuration silo.

> **Project status:** Early open-source release. v0.3.0 is usable today, but interfaces and configuration may change while the project moves toward a stable release.

## Why this project exists

Pi already provides a capable coding-agent runtime, package ecosystem, extension system, session format, and MCP integration. This project focuses on the missing editor experience.

The extension deliberately does **not** implement another agent loop. It launches:

```text
pi --mode rpc
```

and translates Pi's RPC stream into native VS Code workflows. Your existing Pi setup remains the source of truth.

## Highlights

### Dedicated Pi workspace

- Independent **Pi** Activity Bar view
- Streaming assistant text and reasoning
- Sanitized Markdown, tables, links, and syntax highlighting
- Expandable tool cards with state and output
- Copy and Insert actions for code blocks
- Queued follow-ups and cancellation
- Pi model and thinking-level selectors
- Dynamic slash commands from Pi extensions, skills, prompt templates, and MCP prompts

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

### Pi extension UI

Pi extension requests are bridged into VS Code for:

- notifications;
- confirmation;
- selection;
- text input;
- editor input;
- external links.

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

- One Pi RPC sidecar is active at a time. The session library can switch, fork, clone, archive, and restore sessions, but simultaneous live session tabs are planned rather than shipped.
- Native checkpoint review requires a Git worktree. Chat and sessions still work outside Git repositories.
- The MCP control center expects `pi-mcp-adapter` to be configured through Pi.
- The resource/package/settings studio and subagent system described in the roadmap are not implemented yet.
- The extension is currently distributed as a locally built VSIX rather than through the Marketplace.

## Installation

The project is not yet published to the VS Code Marketplace. Build and install a VSIX from source:

```bash
git clone <repository-url>
cd pi-vscode
npm install
npm run package
code --install-extension pi-vscode-0.3.0.vsix --force
```

Then run **Developer: Reload Window** in VS Code.

Alternatively, press `F5` from the repository to launch an Extension Development Host.

## Getting started

1. Open a trusted folder in VS Code.
2. Select the **Pi** icon in the Activity Bar.
3. Optionally move the Pi view to the Secondary Side Bar.
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
| `Pi: Open Chat` | Reveal and focus the Pi view |
| `Pi: New Session` | Start a new Pi session |
| `Pi: Open Session` | Open the searchable session library |
| `Pi: Review Changes` | Review the latest Pi task's file changes |
| `Pi: Stop Agent` | Abort active Pi work |
| `Pi: Restart Agent` | Restart the Pi RPC sidecar |
| `Pi: Ask Pi About Selection` | Open Pi with the current editor selection attached |

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `pi.executablePath` | `pi` | Pi executable used for RPC mode |
| `pi.extraArgs` | `[]` | Additional arguments passed to Pi |
| `pi.approveTrustedWorkspace` | `true` | Pass Pi project-resource approval after VS Code trust is granted |
| `pi.showThinking` | `true` | Display streamed reasoning in collapsible blocks |
| `pi.gitCheckpoints` | `true` | Capture a non-destructive pre-task Git checkpoint for review/revert |

Your models, providers, API credentials, Pi extensions, skills, prompt templates, sessions, and MCP configuration remain in Pi's normal configuration directories.

## Architecture

```text
┌──────────────────────────────────────────────────────┐
│ VS Code extension host                               │
│                                                      │
│  PiViewProvider ── sessions / changes / MCP / context│
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
│  Webview ◀──── validated/bounded host messages       │
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
src/extension.ts          VS Code activation and commands
src/piViewProvider.ts     Current host/webview controller
src/piRpcClient.ts        Pi sidecar and JSONL RPC transport
src/contextMentions.ts    @context parsing and bounds
src/changeReview.ts       Git checkpoints and file restoration
src/sessionLibrary.ts     Pi JSONL session indexing
pi-bridge/index.ts        Pi-to-VS Code MCP status bridge
webview/main.js           Webview source
media/main.css            Webview styling
```

Do not edit `media/main.js` directly; it is generated from `webview/main.js`.

## Testing

The current suite covers:

- incremental JSONL decoding;
- context mention parsing;
- dirty/staged/untracked Git checkpoint safety;
- exact per-file restoration;
- session JSONL metadata and archive behavior;
- webview Markdown, links, change review, and MCP rendering.

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

1. Modular host/webview architecture and stronger integration tests
2. Session export, pinning, compact/reload actions, and runtime health
3. Package, extension, skill, prompt, and agent resource management
4. A bounded read-only VS Code diagnostics/symbol bridge
5. Persistent multi-session tabs and background sessions
6. Read-only Agent Lab subagents
7. Git-worktree-isolated coding agents with native diff review

The detailed checklist is maintained in [GAMEPLAN.md](GAMEPLAN.md).

## Inspiration and attribution

The broader Pi ecosystem has several excellent VS Code experiments. Product and architecture research for this project included:

- [`auchan/pi-on-code`](https://github.com/auchan/pi-on-code)
- [`JohnnyZ93/pi-agent-studio`](https://github.com/JohnnyZ93/pi-agent-studio)

Both are MIT licensed. This project currently maintains its own RPC-sidecar implementation and selectively learns from patterns demonstrated across the ecosystem. Any future direct code adaptation must preserve the relevant copyright and license notices.

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

This is a community-built interface for Pi. It is not an official Pi or VS Code product and is not affiliated with GitHub Copilot.
