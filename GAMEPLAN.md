# PiDE (Pi Development Environment) — Gameplan

This document is the project ledger: what has shipped, what is currently true, and what we intend to build next.

## Status legend

- [x] Implemented and validated
- [ ] Planned; not implemented
- [~] Intentionally deferred or under evaluation

## Product vision

Build a dedicated, independent Pi workspace inside VS Code while keeping the real Pi runtime in charge.

The extension should eventually provide:

- an excellent daily-driver Pi conversation interface;
- native review and recovery for agent changes;
- a searchable workspace over Pi sessions;
- runtime/package/extension/MCP controls;
- persistent multi-session work;
- safe, observable multi-agent orchestration;
- strong integration with VS Code without replacing Pi's agent loop.

## Architectural decisions

- [x] Use `pi --mode rpc` rather than recreating Pi with a separate agent implementation.
- [x] Keep Pi's settings, credentials, packages, extensions, skills, prompt templates, MCP configuration, and JSONL sessions authoritative.
- [x] Use a dedicated PiDE Activity Bar interface independent of Copilot.
- [x] Prefer stable VS Code APIs.
- [x] Let Pi own tool and MCP execution.
- [x] Preserve and reuse existing user/project Pi configuration.
- [x] Introduce a typed, modular runtime architecture before adding multiple live sessions.
- [ ] Enforce one-writer or worktree isolation for future concurrent sessions and agents.

---

# Completed work

## Repository and extension foundation

- [x] Initialized a standalone Git repository.
- [x] Added an MIT license under PiDaddy Labs.
- [x] Added TypeScript extension-host compilation.
- [x] Added an esbuild webview bundle.
- [x] Added Vitest and JSDOM testing.
- [x] Added VS Code development launch/tasks configuration.
- [x] Added VSIX packaging and local installation workflow.
- [x] Added a dedicated PiDE Activity Bar container and icon.
- [x] Packaged and installed v0.3.0 as `pidaddylabs.pide`.
- [x] Packaged, Extension Host-tested, and locally installed the Phase 0 hardening release v0.3.1.
- [x] Renamed the product and extension to **PiDE** (Pi Development Environment), using `assets/PiDE.jpg` for its package, repository, and Activity Bar image.

## Pi runtime and RPC integration

- [x] Launch the real Pi runtime with `pi --mode rpc`.
- [x] Use one JSON object per line for RPC transport.
- [x] Correlate RPC requests and responses with unique IDs.
- [x] Stream Pi events into VS Code.
- [x] Stop and restart the Pi sidecar.
- [x] Abort active Pi work.
- [x] Show startup, ready, failure, and reconnect state.
- [x] Persist the current Pi session per workspace.
- [x] Pass trusted-project approval only after VS Code Workspace Trust is granted.
- [x] Respect configurable Pi executable and extra arguments.
- [x] Load the packaged Pi bridge extension alongside the user's normal Pi extensions.
- [x] Preserve Pi's existing models, credentials, skills, extensions, prompts, sessions, and MCP configuration.

## Conversation interface

- [x] Stream assistant text incrementally.
- [x] Stream reasoning into collapsible thinking blocks.
- [x] Render assistant output as sanitized Markdown.
- [x] Render headings, lists, tables, blockquotes, and links.
- [x] Syntax-highlight fenced code blocks.
- [x] Add Copy and Insert actions to code blocks.
- [x] Render expandable tool invocation/result cards.
- [x] Render tool state and duration.
- [x] Auto-collapse completed tool output.
- [x] Queue follow-up prompts while Pi is working.
- [x] Cancel active work.
- [x] Keep the composer responsive during streaming.
- [x] Add jump-to-latest behavior without stealing scroll position.
- [x] Add model and thinking-level selectors.
- [x] Discover slash commands dynamically from Pi.
- [x] Complete slash commands in the composer.
- [x] Support MCP prompt commands discovered through Pi.
- [x] Handle Pi extension notifications, confirmation, selection, input, and editor requests through VS Code UI.
- [x] Fix stale “Starting Pi…” state after reconnect.

## Context attachments

- [x] Add searchable `@` completion.
- [x] Attach the active editor selection.
- [x] Attach the current file.
- [x] Attach open files.
- [x] Attach VS Code diagnostics/problems.
- [x] Attach Git diff context.
- [x] Attach terminal metadata.
- [x] Attach workspace roots.
- [x] Search and attach workspace files.
- [x] Display removable attachment chips.
- [x] Bound attached context by size and line count.
- [x] Add “Ask Pi About Selection” to the editor context menu.

## Session library

- [x] Discover Pi JSONL sessions for the current workspace.
- [x] Respect Pi's configured/default session directories.
- [x] Parse session ID, name, workspace, creation/update times, and preview.
- [x] Parse user/assistant/tool-call counts.
- [x] Parse model, token usage, and cost metadata.
- [x] Search session user-message content.
- [x] Identify the current session.
- [x] Resume sessions through Pi RPC.
- [x] Rename active sessions.
- [x] Rename inactive sessions through a short-lived Pi RPC helper.
- [x] Fork from a selected historical user message.
- [x] Clone sessions.
- [x] Archive sessions reversibly.
- [x] Restore archived sessions.
- [x] Delete sessions using operating-system trash when available.
- [x] Guard against archiving/deleting the active session.

## Native Git change review

- [x] Capture a checkpoint before each non-slash Pi task.
- [x] Use a temporary Git index so the user's real index is untouched.
- [x] Preserve pre-existing tracked, staged, dirty, and untracked work.
- [x] Store checkpoint commits under `refs/pide/checkpoints/`.
- [x] Prune old checkpoint refs.
- [x] Calculate changed files after Pi settles.
- [x] Track added, modified, deleted, and renamed paths.
- [x] Calculate additions and deletions.
- [x] Open native VS Code before/after diffs.
- [x] Mark individual files accepted/reviewed.
- [x] Revert individual files to their exact pre-task state.
- [x] Review all files from the latest task.
- [x] Persist the latest change set across extension reloads.
- [x] Keep accept semantics separate from Git staging/committing.

## MCP control center

- [x] Reuse the installed `pi-mcp-adapter` rather than implementing another MCP client.
- [x] Package a small Pi bridge that forwards adapter status to VS Code.
- [x] Display server status.
- [x] Display tool and resource counts.
- [x] Reconnect one server.
- [x] Reconnect all servers.
- [x] Enable and disable servers through adapter commands.
- [x] Restart Pi after persisted MCP enable/disable operations.
- [x] Hand OAuth authentication through Pi's MCP commands/UI.
- [x] Surface MCP prompts in the control center.
- [x] Preserve Pi extension approvals and prompts.
- [x] Open existing MCP configuration files.
- [x] Create a project `.mcp.json` when no MCP configuration exists.
- [x] Validate the packaged bridge against configured MCP servers in a real Pi runtime.

## Tests and validation

- [x] Test chunked JSONL decoding.
- [x] Test context-mention parsing.
- [x] Test dirty-worktree checkpoint/revert behavior in temporary Git repositories.
- [x] Test session parsing and archive/restore.
- [x] Test webview Markdown, links, change review, and MCP rendering in JSDOM.
- [x] Run TypeScript compilation and webview bundling in the standard check.
- [x] Validate real Pi streaming and tool execution.
- [x] Validate VSIX packaging and local installation.
- [x] Validate discovery of a real extension-created Pi session.

### Current release snapshot

- Version: `0.6.0`
- Extension ID: `pidaddylabs.pide`
- Feature baseline commit: `f165e3a`
- Original implementation commit: `ebeceb3`
- Tests at v0.3.2: 17 Vitest tests plus 3 Extension Host integration checks
- Current UI model: one capability-probed RPC runtime in a retained Activity Bar webview

---

# Planned improvements

Everything below is not implemented unless its checkbox is later marked complete.

## Phase 0 — Architecture hardening — completed in v0.3.1

Goal: make the current implementation modular enough to support multiple runtimes and richer control panels without turning the provider/webview into monoliths.

- [x] Define a shared typed host/webview protocol.
- [x] Convert webview source to TypeScript modules.
- [x] Split runtime lifecycle out of `PiViewProvider`.
- [x] Split session actions and indexing into a session service/controller.
- [x] Split change review into a workspace-scoped service/controller.
- [x] Split MCP status/actions into a controller.
- [x] Split extension UI request handling into a bridge router.
- [x] Add a central runtime event model.
- [x] Add Pi capability detection instead of relying on version assumptions.
- [x] Improve Pi binary auto-discovery.
- [x] Add a runtime-health/onboarding panel.
- [x] Declare unsupported untrusted and virtual workspaces in the manifest.
- [x] Disable agent startup until Workspace Trust is granted.
- [x] Add VS Code Extension Host integration tests.
- [x] Add recorded RPC contract fixtures.
- [x] Add formal third-party attribution documentation.

### Exit criteria

- [x] No visible feature regressions in the automated DOM, Git, session, RPC, and Extension Host coverage.
- [x] Existing tests pass, with the suite expanded from 13 to 17 Vitest tests plus 2 Extension Host checks.
- [x] A real Pi 0.84.1 RPC smoke test passes with capability discovery and MCP bridge status.
- [x] Trust/runtime failures have actionable onboarding UI.
- [x] New runtime, protocol, session, change, MCP, and extension-UI subsystems can be exercised without constructing the entire view provider.

## Phase 1 — v0.4 low-hanging fruit — completed in v0.4.0

### Session improvements

- [x] Pin and favorite sessions.
- [x] Copy session ID.
- [x] Copy/open session path.
- [x] Export a session to HTML (active sessions use RPC; inactive sessions use `pi --export`).
- [x] Show context-window usage.
- [x] Add compact-session action.
- [x] Add reload-context action.
- [x] Show auto-compaction and auto-retry state.
- [x] Add running/idle badges. Unread badges are a Phase 2 background-session feature.
- [x] Persist session filters and sorting.
- [x] Improve automatic session display names.
- [x] Add “Open in Pi terminal.”

### Runtime and resource control center

- [x] Display Pi version, binary path, agent directory, and session directory.
- [x] List configured packages with user/project scope.
- [x] Install packages through `pi install`.
- [x] Remove packages through `pi remove`.
- [x] Update packages through `pi update --extensions`.
- [x] List loaded extensions.
- [x] List skills and show source/scope.
- [x] List prompt templates and show source/scope.
- [x] List agent definitions and show source/scope.
- [x] Open resource files.
- [x] Create, rename, and delete user/project skills.
- [x] Create, rename, and delete prompt templates.
- [x] Create, rename, and delete agent definitions.
- [x] Clearly warn about trusted project-local executable resources.
- [x] Restart/reload Pi when resource changes require it.

### Read-only VS Code bridge

- [x] Add a lean `vscode_context` Pi tool.
- [x] Support diagnostics.
- [x] Support active selection/editor state.
- [x] Support open-editor metadata.
- [x] Support document/workspace symbols.
- [x] Support definitions.
- [x] Support references.
- [x] Support hover information.
- [x] Add `/vscode-selection`.
- [x] Add `/vscode-diagnostics`.
- [x] Add `/vscode-symbols`.
- [x] Add `/vscode-references`.
- [x] Keep all bridge results bounded.
- [x] Keep editor mutation disabled in the first bridge release.

### Extension UI

- [x] Render selection requests inline.
- [x] Render confirmation requests inline.
- [x] Render text/editor input inline.
- [x] Render multi-question questionnaires inline as a structured editor response.
- [x] Add reusable todo/status widgets.
- [x] Keep native VS Code dialogs as fallback.

## Phase 2 — v0.5 persistent multi-session workspace — completed in v0.5.0

- [x] Introduce a `PiRuntimeManager` owning multiple session runtimes.
- [x] Add persistent open-session tabs.
- [x] Restore open tabs after VS Code reload.
- [x] Lazily start dormant session sidecars.
- [x] Keep actively streaming background sessions alive.
- [x] Display background progress and completion badges.
- [x] Add unread indicators.
- [x] Prevent duplicate sidecars for one session.
- [x] Add a configurable maximum number of active runtimes.
- [x] Suspend idle runtimes without closing their session tabs.
- [x] Scope prompt queues to each session.
- [x] Scope change sets/checkpoints to each session/task.
- [~] Editor-area and optional side-by-side views remain deferred to avoid proposed VS Code APIs and keep the stable Activity Bar UI authoritative.
- [x] Implement a workspace write lease for non-isolated runtimes.
- [x] Run waiting sessions read-only or queue them while another session owns the write lease.

### Exit criteria

- [x] Two sessions can stream independently through separate managed runtimes.
- [x] VS Code reload restores the session layout.
- [x] Background completion is visible through tab state and unread badges.
- [x] Concurrent root-workspace writes are prevented by the workspace write lease.
- [x] Each session has independent runtime state and prompt queue; change review remains scoped to the active task/session checkpoint.

## Phase 3 — v0.6 Agent Lab MVP — completed in v0.6.0

- [x] Discover user agents from `~/.pi/agent/agents/*.md`.
- [x] Discover project agents from `.pi/agents/*.md`.
- [x] Support name, description, model, tools, and invocation policy frontmatter.
- [x] Add Architect role.
- [x] Add Explorer role.
- [x] Add Reviewer role.
- [x] Add Tester role.
- [x] Add Researcher role.
- [x] Add Security role.
- [x] Add Documentation role.
- [x] Spawn each subagent in an isolated Pi process.
- [x] Start with an exact read-only tool allowlist in role metadata and safety prompt.
- [x] Forbid `edit`, `write`, and unrestricted `bash` in the MVP with runtime tripwire aborts.
- [x] Support bounded parallel execution.
- [x] Default to no more than four concurrent subagents.
- [x] Stream progress and tool events.
- [x] Show status and duration; token/cost budgets are surfaced as soft per-agent prompt budgets until Pi exposes child usage totals over RPC.
- [x] Add per-agent token/cost budgets.
- [x] Add stop and retry controls.
- [x] Return bounded results to the parent PiDE UI.
- [x] Show complete results in Agent Lab.
- [x] Add optional Honcho peer identities as a role-frontmatter/design hook.
- [x] Prevent noisy transcripts from being written to Honcho memory through role instructions and no automatic memory writes.

### Exit criteria

- [x] Agent Lab cannot intentionally modify the workspace: child Pi processes run in isolated temp directories, are not approved for project-local resources, and abort on forbidden write-capable tool starts.
- [x] Cancellation terminates all child processes.
- [x] Limits are enforced.
- [x] Parent-agent failures do not crash subagents and vice versa.
- [x] Costs are visible and bounded through per-agent soft token budgets; exact child usage totals remain dependent on Pi RPC usage events.

## Phase 4 — v0.7 safe coding agents

- [ ] Create a dedicated Git branch/worktree per writing agent.
- [ ] Capture main-workspace state before launching an implementer.
- [ ] Track worktree ownership and lifecycle.
- [ ] Run writing agents only in their assigned worktree.
- [ ] Capture a per-agent change set.
- [ ] Run selected validation inside the agent worktree.
- [ ] Present agent diffs in native VS Code review.
- [ ] Accept or reject individual agent files.
- [ ] Generate/apply a patch from selected changes.
- [ ] Detect merge conflicts before integration.
- [ ] Require explicit approval before merging.
- [ ] Recover and clean up abandoned worktrees after crashes.
- [ ] Support Architect → Implementer → Tester → Reviewer workflows.
- [ ] Compare competing implementations.
- [ ] Preserve a complete audit trail of agent actions and outcomes.

## Phase 5 — advanced studio backlog

- [ ] Package marketplace search.
- [ ] Safe package metadata and preview rendering.
- [ ] Rich model/provider configuration with schema validation.
- [ ] Masked provider/auth readiness dashboard.
- [ ] Mermaid rendering.
- [ ] KaTeX math rendering.
- [ ] Model vendor icons.
- [ ] Conversation minimap.
- [ ] Incremental history pagination.
- [ ] Session lineage/branch graph.
- [ ] Compare two sessions.
- [ ] Non-Git file snapshot fallback.
- [ ] `/btw` side questions that do not alter the main thread.
- [ ] Saved agent teams.
- [ ] Saved project workflows/playbooks.
- [ ] Per-team cost budgets.
- [ ] Permission profiles by agent role.
- [ ] Explicitly approved VS Code code actions and workspace edits.
- [ ] Localization.
- [~] AI-generated commit messages.
- [~] Terminal-first interface; likely limited to an “Open in Terminal” action.

---

# Reference-project findings

We reviewed two MIT-licensed Pi VS Code projects for ideas:

## `auchan/pi-on-code`

Strong ideas:

- persistent multi-session workspace;
- rich streaming and conversation navigation;
- package/extension marketplace;
- session tabs and side-by-side panes;
- consolidated VS Code bridge tool;
- session export and history navigation.

Decision: adopt selected product ideas, but retain our RPC-sidecar architecture instead of dynamically hosting Pi's SDK in the VS Code process.

## `JohnnyZ93/pi-agent-studio`

Strong ideas:

- per-panel Pi RPC sessions;
- full resources/settings studio;
- bundled todo, questionnaire, permission, rewind, and subagent extensions;
- local editor bridge;
- structured agent definitions;
- parallel subagent output and usage reporting;
- Mermaid/math/model-brand presentation.

Decision: use its extension-pack and Agent Lab concepts as inspiration, but do not duplicate its MCP stack or allow writing subagents to share the primary worktree.

## Explicit non-goals

- Recreating Pi's agent loop
- Forking Pi's session format
- Maintaining a second credential store
- Building another MCP client implementation
- Exposing a large set of autonomous editor-mutation tools by default
- Running multiple write-capable agents concurrently in the same working tree
- Treating repository `HEAD` as the user's pre-task state

---

# Definition of done

A planned item becomes complete only when:

1. Its implementation uses Pi/VS Code authoritative APIs rather than duplicating core behavior.
2. User data, credentials, Git state, and project trust are handled safely.
3. It has focused automated tests.
4. TypeScript, webview build, and the full test suite pass.
5. A packaged VSIX contains the required runtime files.
6. The feature is smoke-tested against a real Pi process.
7. `README.md`, `AGENTS.md`, and this file reflect the shipped behavior.
