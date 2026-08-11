# Pi Coding Agent for VS Code

A dedicated, independent VS Code chat interface powered by the real [Pi coding agent](https://pi.dev) runtime.

## Current status

This repository contains the first working vertical slice:

- Dedicated **PI** Activity Bar view
- Pi RPC sidecar (`pi --mode rpc`)
- Streaming assistant text and reasoning rendered as sanitized Markdown
- Syntax-highlighted code blocks with Copy and Insert actions
- Tables, lists, headings, blockquotes, and safe external links
- Expandable tool invocation cards
- Cancellation and queued follow-ups
- Model and reasoning-level pickers
- Dynamic Pi slash-command completion
- Persistent per-workspace sessions with recent-chat switching
- Existing Pi extensions, skills, prompts, MCP servers, and credentials
- VS Code Workspace Trust and Pi project-resource approval
- Extension confirmation/input dialogs rendered with native VS Code UI
- Searchable `@` context completion for selection, current file, open files, diagnostics, Git diff, terminal metadata, workspace roots, and workspace files
- Removable context attachment chips and bounded context payloads

## Requirements

- VS Code 1.100 or newer
- Pi installed and configured on the workspace machine
- `pi` available on `PATH`, or set `pi.executablePath`

For Remote SSH, WSL, or dev containers, install/configure Pi in the remote workspace environment because this extension runs as a workspace extension.

## Development

```bash
npm install
npm run check
```

Press `F5` from VS Code to launch an Extension Development Host.

To create a VSIX:

```bash
npm run package
```

## Usage

1. Open a trusted folder or workspace.
2. Select the **PI** icon in the Activity Bar.
3. Move the PI view to the Secondary Side Bar if desired.
4. Start chatting.

Use the `@` composer button to attach the current editor and selection. Type `/` to browse commands discovered from Pi extensions, prompt templates, skills, and MCP prompts.

## Architecture

The extension does not recreate Pi's agent loop. It launches Pi in RPC mode and translates Pi's JSONL events into VS Code UI. Pi remains responsible for models, tools, extensions, MCP, sessions, compaction, retries, and permissions.

Credentials remain in Pi's credential store and are never copied into the webview.
