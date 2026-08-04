# M1c — The roles library and the onboarding agent

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Two things that make the factory usable by someone who does not know Claude Code's configuration surface. **Roles**: pick "architect" or "QA" and the agent arrives with the right prompt, skills, tools and model already attached. **Onboarding**: point the factory at an empty or undocumented folder and an agent interviews you in the browser, then writes the project's CLAUDE.md and README and proposes its first rooms.

**Architecture:** A role is a file (`roles/*.yaml` in the repo, user overrides in `.fabrica/roles/`), not a table — it is content, and content belongs in files an operator can read and fork. Applying a role composes an agent's `appendSystemPrompt`, `allowedTools`, `mcpServers`, `model` and the skills copied into the room's `.claude/`. The onboarder is an ordinary session with a role and a one-shot job, exactly as the orchestrator is.

**Conventions:** server tests `bun test`, web/shared vitest, installs pnpm. **Never set `SUPERFABRIC_LIVE_TEST=1`; never prompt a real agent** except in the acceptance task. Commit per task.

---

### Task 1: Role files and the loader

- [ ] `RoleSpec` in shared: `id`, `name`, `summary` (one line, shown in the picker), `promptAppend`, `model?`, `skills?: string[]`, `mcpServers?`, `allowedTools?`, `autonomy?`.
- [ ] `roles/*.yaml` in the repo root — the shipped presets. `.fabrica/roles/*.yaml` overrides by `id`. A malformed file must be reported, not silently skipped: the operator needs to know their preset is broken.
- [ ] `RoleLibrary`: `list()`, `get(id)`, and a reload that picks up an edited file without a restart (an operator tuning a preset should not have to bounce the server).
- [ ] Tests: shipped roles all parse; a user file overrides a shipped one by id; a malformed file surfaces an error naming the file; unknown fields are rejected rather than ignored (a typo in a preset should not silently do nothing).

### Task 2: Ten presets worth shipping

- [ ] Write ~10 roles that are genuinely useful rather than filler: architect, backend, frontend, designer, QA, DevOps, tech writer, data, security reviewer, generalist.
- [ ] Each `promptAppend` must be **short and specific** — a charter, not an essay. State what the role owns, what it should not do, and how it should hand off. Reuse the tone of the orchestrator's prompt (`orchestrator.ts`) — it is the worked example and it is deliberately brief.
- [ ] Skills: reference real, public skill packs where one genuinely fits (this repo's own `superpowers` and `impeccable` are the obvious two). **Do not invent skill names.** If no skill fits a role, ship it without one — an aspirational reference that resolves to nothing is worse than none.
- [ ] Model per role: use the shortlist already in shared. Reserve the most capable model for roles that need judgement (architect, security), not for everything.
- [ ] Tests: every shipped role parses, has a non-empty summary and promptAppend, and names only models in the shortlist and skills that exist (check the skill exists before claiming it — if you cannot verify, do not reference it).

### Task 3: Applying a role

- [ ] `create_session {roleId?}` and `set_role {sessionId, roleId|null}`. Persist `role_id` on the session (migration), re-apply on resume, mirror the shape `setModel`/`setAccount` already use.
- [ ] Applying composes: role `promptAppend` + the room's own charter context; role `model` unless the operator chose one explicitly (an explicit choice always wins over a preset); role `allowedTools`/`mcpServers` merged with the factory's own in-process server, which is never removed.
- [ ] Skills install into the room's `.claude/skills/` so the repo stays self-contained and a plain Claude Code session in that folder gets them too. Never overwrite a skill the operator has edited.
- [ ] UI: a role picker when creating an agent and on an existing agent, showing name + summary. Keep the shadcn idiom.
- [ ] Tests: role composes into the recorded executor options; an explicit model beats the role's; the factory MCP server survives an `mcpServers` from a role; role survives restart; clearing a role reverts to plain.

### Task 4: The onboarding agent

- [ ] Detect an un-onboarded project: no `CLAUDE.md` at the project root (that is the honest signal — do not guess from folder contents).
- [ ] `start_onboarding {projectId}` creates a short-lived session in the project room with an onboarding role whose prompt says: interview the operator about what this project is, who it is for and where it is going; ask **one question at a time**; when you have enough, write `CLAUDE.md` and `README.md` at the project root and propose an initial set of rooms with one-line charters.
- [ ] The proposal is a **proposal**: the operator approves rooms before folders are created. Do not have the agent create rooms directly — it can call a tool that suggests them, and the UI shows them as an accept/edit list. A factory that reorganises itself on an interview's say-so is not what an operator wants on first contact.
- [ ] The UI surfaces onboarding prominently when a project is un-onboarded (this is first-contact — it should be obvious), and not at all otherwise.
- [ ] Tests: detection is by file presence; the session is created with the onboarding role in the project room; the suggest-rooms tool records suggestions without creating folders; accepting creates them through the normal `createRoom` path (so every existing invariant still applies).

### Task 5: Acceptance

- [ ] **One live run**: point the factory at an empty throwaway folder, run onboarding, answer a few questions honestly about a small imaginary project, and let it write the docs and propose rooms. Accept them. Report verbatim what it asked, what it wrote, and whether the rooms it proposed made sense.
- [ ] Create one agent with a role and confirm from the recorded options that the prompt, model and skills actually arrived.
- [ ] Update `docs/ROADMAP.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`.

---

## Self-review notes

- **Covers** the two remaining M1 items and the "50 roles so a non-expert can use it" idea from the vision — shipped as 10 good ones with a file format the operator can extend, which is the honest version of "50".
- **Deferred**: containers (M4), glTF characters and metrics (M5).
- **Risk**: role prompts are content, and bad content is worse than none. The mitigation is brevity and the rule against inventing skill references.
