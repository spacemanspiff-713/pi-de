# Phase 5B — Chat Window UI/UX Improvements Discovery

Status: research and product design only. Do not implement from this file without a separate build phase.

## Goal

Turn the current PiDE chat sidebar into a more sophisticated **agent swarm management board** while staying inside stable VS Code extension APIs and PiDE's RPC-sidecar architecture.

The board should let a user understand and control:

- the primary Pi chat session;
- open session tabs;
- Agent Lab roles and role overrides;
- live subagent runs;
- worktree-backed implementers;
- review/validation/merge state;
- MCP/resource/runtime health;
- costs, caps, tool use, and failures.

## Research baseline

The Researcher agent found the most relevant VS Code UI/styling docs:

1. Webview API guide
   - https://code.visualstudio.com/api/extension-guides/webview
   - Use webviews only when native VS Code APIs are insufficient.
   - Keep CSP strict.
   - Use `asWebviewUri` for local resources.
   - Keep message passing explicit and typed.

2. UX Guidelines overview
   - https://code.visualstudio.com/api/ux-guidelines/overview
   - Fit into VS Code containers/items instead of inventing a separate app metaphor.
   - Use the Activity Bar/sidebar, panels, view actions, status, quick picks, and settings intentionally.

3. Webviews UX guidelines
   - https://code.visualstudio.com/api/ux-guidelines/webviews
   - Theme all elements.
   - Keep behavior related to the editor.
   - Avoid wizard/promo style UIs.
   - Provide toolbar actions instead of hiding important controls.
   - Preserve accessibility and keyboard interaction.

4. Theme Color reference
   - https://code.visualstudio.com/api/references/theme-color
   - Use `--vscode-*` CSS variables instead of hard-coded colors.
   - Test dark, light, high contrast, and high contrast light themes.

5. Useful secondary source
   - https://www.eliostruyf.com/code-driven-approach-theme-vscode-webview/
   - Helpful for CSS-variable-driven webview theming and observing theme changes.

6. Cautionary source
   - `microsoft/vscode-webview-ui-toolkit` was identified, but a fetch returned HTTP 503 during the agent run.
   - Treat it as “verify before adopting.” Do not depend on it until current maintenance/status is checked.

## Current PiDE chat anatomy

Current DOM/layout from `src/piViewProvider.ts` and `webview/main.ts`:

```text
body
├── topbar
│   ├── brand/status
│   └── icon actions: sessions, resources, agent-lab, compact, reload, changes, MCP, new, restart, output
├── session-tabs
├── selectors: model, thinking, context stats
├── banner
├── runtime-health
├── widget
├── extension-request
├── change-summary
├── transcript
├── jump button
├── changes-panel overlay
├── agent-lab-panel overlay
├── mcp-panel overlay
└── composer-shell
    ├── context chips
    ├── prompt textarea
    ├── attach/queue/stop/send
    └── command/context completion menus
```

Strengths:

- compact sidebar-first design;
- native VS Code colors;
- typed webview protocol;
- retained context;
- good core chat loop;
- Agent Lab already has run cards, role editing, tool telemetry, worktree review;
- side panels avoid proposed VS Code Chat/MCP APIs.

Weaknesses:

- too many topbar icon-only actions;
- Agent Lab is a slide-over panel, not a persistent board;
- no global swarm overview/status lane;
- role selection and run cards compete for the same vertical space;
- primary chat and subagent outputs are visually disconnected;
- no timeline across parent prompt → agent runs → diffs → validation → merge;
- no source/citation panel for research agents;
- no cost/tool/cap summary dashboard;
- no saved teams/playbooks UI;
- limited keyboard navigation for Agent Lab objects;
- no responsive split between narrow sidebar and wider editor panel modes.

## Desired product metaphor

Move from:

> Chat transcript with hidden drawers

To:

> Mission-control board for one primary Pi session plus a swarm of controlled subagents

The UI should make this obvious:

```text
Primary Pi thread = commander lane
Agent Lab = swarm lanes
Implementer worktrees = reviewable artifacts
MCP/resources/runtime = system status
Composer = tasking console
```

## Proposed information architecture

### 1. Board shell

Replace the current single-stack mental model with board regions:

```text
┌──────────────────────────────────────────────┐
│ Command bar: workspace, session, model, health│
├──────────────────────────────────────────────┤
│ Swarm strip: active agents, caps, cost, alerts │
├──────────────────────────────────────────────┤
│ Main area                                      │
│ ├─ Commander thread / transcript               │
│ ├─ Agent lanes / run cards                      │
│ └─ Artifact inspector                           │
├──────────────────────────────────────────────┤
│ Composer + context + dispatch controls          │
└──────────────────────────────────────────────┘
```

Narrow sidebar mode:

- collapse to stacked tabs: Chat / Swarm / Artifacts / System;
- keep composer fixed at bottom;
- show only active/alerted agents in the swarm strip.

Wide/editor-panel future mode:

- 2–3 columns:
  - left: sessions/roles/team presets;
  - center: commander transcript;
  - right: swarm board/artifact inspector.

### 2. Command bar

Current topbar actions should become labeled groups or overflow menus:

- Session: new, library, tabs, compact/reload
- Swarm: Agent Lab, run team, stop all
- Review: changes, agent artifacts
- System: MCP, resources, runtime, output

Use tooltips, `aria-label`, and active badges.

### 3. Swarm strip

A compact always-visible strip above the transcript:

```text
Architect idle | Researcher running 4/12 tools | Implementer needs review | Reviewer failed
```

Each chip shows:

- role icon/name;
- model/provider short label;
- status color;
- elapsed time;
- tool count/cap;
- unread/result badge;
- click to focus the run card.

### 4. Agent run cards

Each run card should have consistent sections:

```text
[Researcher] running       model: openrouter/deepseek...   5/12 tools   0:38
Task: Find useful VS Code extension UI styling docs
Progress: fetching official docs
Tools: web_fetch 4 · brave_search 1
Result preview / final answer
Sources / failed fetches
Actions: Stop · Retry · Promote to chat · Save as note
```

For Implementer:

```text
[Implementer] needs review   branch: pide/agent/implementer/abc123
Changed files: 3   Validation: failed   Merge conflicts: none
Files: [x] src/foo.ts  [x] test/foo.test.ts  [ ] docs/foo.md
Actions: Diff · Validate · Apply selected patch · Merge branch… · Clean up
```

### 5. Artifact inspector

A right-side panel/drawer for selected run artifacts:

- final answer;
- sources/citations;
- failed fetches;
- tool trace;
- worktree file list;
- validation logs;
- audit trail;
- cost/usage if available.

This avoids overloading every run card.

### 6. Composer as dispatch console

Composer should support dispatch target modes:

- Ask Pi only
- Ask selected agents
- Ask Pi + agents
- Implement in worktree
- Review current changes
- Research web/docs only

Possible controls:

```text
Target: [Pi thread ▼] [Architect] [Researcher] [Implementer]
Mode: Ask / Plan / Research / Implement / Review
Context: @selection @diagnostics @git-diff
Send
```

This would make subagents feel native instead of hidden in Agent Lab.

### 7. Source/citation board for research agents

Research agents should produce structured source artifacts:

- URL;
- title;
- status;
- official/secondary/community tag;
- short usefulness note;
- failed fetch reason.

UI should expose:

```text
Sources found: 6 official · 1 secondary · 1 failed
```

Then list expandable cards.

### 8. Team presets and playbooks

Phase 5B should design for, but not necessarily build immediately:

- saved teams: “Research + Docs”, “Architect + Explorer + Reviewer”, “Implement + Test + Review”;
- saved playbooks: ordered workflows with handoff prompts;
- per-team max cost/tool budget;
- default models per role;
- default validation command per project.

### 9. Timeline

Show a chronological task timeline:

```text
11:02 User prompt
11:03 Architect completed plan
11:04 Researcher found 5 sources
11:06 Implementer created worktree
11:08 Validation failed
11:10 Patch applied: 2 files
```

This gives auditability and makes swarm work understandable.

### 10. Notifications and attention model

Use clear badges:

- running;
- waiting for review;
- validation failed;
- merge conflict;
- no final answer;
- tool cap hit;
- duration cap hit;
- failed fetches;
- cost/budget warning.

Avoid modal spam except for destructive/integrating actions.

## Styling principles

Based on VS Code docs/research:

- Use `--vscode-*` variables only.
- Prefer VS Code primitives visually:
  - buttons;
  - list rows;
  - badges;
  - tree-ish sections;
  - tabs;
  - split panes;
  - status chips.
- Avoid marketing-dashboard styling.
- Make dense info scannable, not flashy.
- Use restrained icons/codicons if possible.
- Test four theme modes:
  - Dark+;
  - Light+;
  - High Contrast;
  - High Contrast Light.
- Keep keyboard navigation explicit:
  - tab through role chips/cards/actions;
  - arrow navigation inside agent lists;
  - Enter opens selected card;
  - Escape closes inspector/drawers.

## Accessibility requirements

Minimum requirements before implementation is accepted:

- labels for all icon-only actions;
- `aria-live` regions for run completion/failure;
- semantic buttons, headings, lists;
- focus outline not suppressed;
- keyboard-operable agent cards;
- reduced-motion preference respected;
- color not the only status indicator;
- high contrast pass for status chips and validation states.

## Technical architecture notes

### Keep

- one webview bundle for now;
- strict CSP;
- typed host/webview protocol;
- Pi owns model/tool/session/MCP execution;
- PiDE controls layout, review, and orchestration;
- stable VS Code APIs only.

### Avoid

- proposed VS Code Chat APIs;
- proposed MCP UI APIs;
- duplicate MCP implementation;
- making subagents share the main worktree;
- background writes without review;
- heavy third-party component libraries before verifying maintenance.

### Possible module split

Current `webview/main.ts` is becoming large. Phase 5B implementation should split into:

```text
webview/
├── main.ts
├── markdown.ts
├── chatTranscript.ts
├── agentBoard.ts
├── agentCards.ts
├── artifactInspector.ts
├── composer.ts
├── systemPanels.ts
└── a11y.ts
```

Host-side controller split may also need:

```text
src/controllers/
├── agentLabController.ts
├── agentRoleController.ts
├── agentRunTelemetry.ts
├── agentArtifactController.ts
└── agentWorkflowController.ts
```

## Build phases proposal

### 5B.1 — Board skeleton and navigation

- Add visible Chat / Swarm / Artifacts / System tabs.
- Add persistent swarm strip.
- Keep existing drawers working.
- No behavior changes yet.

### 5B.2 — Agent run card redesign

- Normalize run card sections.
- Show source/failure/tool/audit tabs inside each run.
- Improve worktree review cards.

### 5B.3 — Artifact inspector

- Add selected-run inspector panel.
- Move long logs/results out of cards.
- Add source/citation cards.

### 5B.4 — Dispatch console

- Let composer target Pi, selected agents, or teams.
- Add explicit “Research”, “Plan”, “Implement”, “Review” dispatch modes.

### 5B.5 — Teams/playbooks discovery slice

- Design saved teams/playbooks data format.
- Add UI mock plus non-executing saved team picker.

### 5B.6 — Accessibility/theme pass

- Keyboard map.
- High contrast fixes.
- Reduced motion.
- Screen-reader labels and live regions.

## Suggested first implementation slice

Start with **5B.1 + 5B.2 only**.

Why:

- low architectural risk;
- immediately makes Agent Lab understandable;
- does not change Pi orchestration;
- improves current user pain from the recent agent experiments;
- creates the containers needed for later artifact/team work.

Definition of done for 5B.1/5B.2:

- current chat still works;
- Agent Lab can still run and review agents;
- swarm strip shows run statuses and caps;
- run cards show model/tool/failure/source summaries;
- narrow sidebar remains usable;
- no new proposed APIs;
- DOM tests cover basic rendering;
- themes and high contrast are smoke-tested.

## Open questions

1. Should the swarm board stay inside the Activity Bar sidebar, or should PiDE also offer an optional editor-area “Agent Board” panel?
2. Should research sources become a typed artifact in the host protocol, or be parsed from final Markdown?
3. Should saved teams be regular `.pi/agents/teams/*.md` files, JSON, or prompt templates?
4. Should the primary Pi chat be able to ingest agent results with a “Promote to chat” action?
5. Should there be a strict global run budget across all agents, not just per-run caps?
6. Should Implementer validation support multiple named commands instead of one `pide.agentLabValidationCommand`?
7. Should role overrides have a schema validator and visual editor?

## Non-goals for Phase 5B

- Replacing Pi's agent loop.
- Moving MCP execution into VS Code.
- Publishing to Marketplace.
- Implementing a full custom UI framework.
- Automatically merging agent work.
- Automatically writing Honcho memory from agent transcripts.
