# SuperFabric — Product Vision

> 🇷🇺 Русский оригинал: [VISION.ru.md](VISION.ru.md) — a snapshot of 2026-08-03; this file
> is the maintained one.

**What this document is.** The brief the product was built against, kept as a statement of
intent rather than rewritten into a description of what shipped. It was written on
2026-08-03 and re-read against the code on 2026-08-04, at the end of M5: the paragraphs
below are all now true of something that exists, except where they are marked. What is
*not* built is listed in [ROADMAP.md](ROADMAP.md#what-is-not-built) rather than quietly
softened here — a vision that edits itself to match the implementation stops being a vision.

## Refined brief

> **SuperFabric** is a self-hosted browser app for running the development of one
> software project with a team of Claude Code agents spread across several subscription
> accounts.
>
> The UI is a **living 3D factory** (isometric WebGL scene): at the center stands the
> **main project building** — a live representation of CLAUDE.md, README, and product
> documents; if they don't exist, an onboarding agent interviews the user right in the
> browser and creates them. Around it are **workshop rooms** — areas of responsibility
> (backend, frontend, devops, chat-service, payment-service…). Between the buildings run
> **conveyor belts** carrying package-messages; later, small animated agent characters
> appear inside the workshops. Above the 3D scene floats a 2D layer of panels: the
> **task panel**, limit meters, approval cards, chats. A room = a project subfolder +
> its documentation + one or more **agents** (Claude Code sessions), each with its own
> model, skills, MCP servers, and permissions.
>
> Agents are created from a **roles library**: ready presets (architect, designer, backend
> developer, QA, DevOps, tech writer…), where a role = a system prompt + recommended
> skills + MCP servers + a recommended model. Pick a role and SuperFabric attaches the
> whole bundle — no need to understand skills and configs. Presets are plain YAML files, so
> they are customizable and shareable by copying them. *(**Eleven** ship, not the "dozens"
> the first draft of this brief promised. The format is the deliverable and the count is
> not; the honest version is that eleven is where the shipped library stands.)*
>
> Departments exchange tasks and questions through the **factory MCP bus** (the chat
> room asks the payments room for push-notification webhooks — and receives the answer
> when the work is done). The **orchestrator** is the senior agent in the headquarters
> building: it distributes work, clears blockers, makes technical direction decisions,
> and junior agents come to it for research and rulings.
>
> **One SuperFabric, many factories.** The user picks the project folder in the UI and can
> switch between projects — each is its own factory floor with its own rooms, agents,
> tasks and history. A room defaults to a subfolder of the project, but its working folder
> can be pointed anywhere: a department may live in a separate repository.
>
> **Files go in by hand, paths go to the agent.** Anything the user pastes from the
> clipboard, drops onto the window, or uploads is saved into the project (or the room's)
> folder, and the agent simply receives the path — the way a colleague would be handed a
> file on disk rather than an attachment.
>
> Accounts are added right from the UI: a link to open and a box for the code the Claude
> sign-in page gives back, against a `CLAUDE_CONFIG_DIR` of that account's own; every new
> room or agent is then bound to one of the registered accounts. *(The brief expected an
> embedded terminal. Probing found `claude auth login` needs no TTY at all, so the flow is
> two fields and there is no terminal emulator in the product —
> [decision 0004](decisions/0004-account-login-over-a-pipe.md).)* Claude Code is the first
> supported engine; the core is built against an **executor abstraction**, so other agents
> (Codex / ChatGPT agents, Antigravity, …) plug in later — different strengths for
> different tasks. *(Two implementations of that seam ship, and both drive Claude Code:
> in-process, and inside a container. No second provider exists.)*
>
> The factory keeps a **chronicle**: every prompt, every decision, and its reasoning is
> preserved — the stream of thought of how the product evolved. Any agent (or the user)
> can search it and learn *why* something was built one way and not another, and what
> to change where, before touching anything.
>
> The user sees everything: open tasks, who works on what, who is idle, who waits on a
> blocker, animated message flows between rooms — and can message any agent directly.
> The **limit monitor** shows, per subscription, the exact picture of 5-hour and weekly
> windows (including per-model buckets), warns agents when a limit approaches, pauses
> them, and automatically resumes sessions from the same spot after reset — plus a burn
> rate beside each meter, saying how long the account has at the rate it is going, or
> **unknown** when there is too little history to say. Sessions survive restarts: all state
> is cached and restored. *(The "exact picture" is exact only while Anthropic's own
> undocumented usage endpoint answers. When it does not, a local estimate stands in and
> every figure it produces is visibly marked as a guess — that honesty is part of the
> vision, not a compromise of it.)*

> **A factory can be moved.** The floor — its rooms, their staffing, the board and the index
> of what has been decided — exports to one file and rebuilds elsewhere. Credentials never
> travel with it: an account is referenced by the label its owner gave it, and re-bound by
> hand on arrival.

## Principles

1. **Self-hosted and local.** No cloud middleman. Code, credentials, and transcripts
   never leave the user's machine.
2. **Your accounts — your responsibility.** SuperFabric manages accounts the user
   logged into personally. We do not "offer claude.ai login" to third parties and we do
   not pool other people's accounts (see risks in RESEARCH.md).
3. **The filesystem is the source of truth.** A room is a folder. A department's docs,
   agents, and skills live in its folder. Turn SuperFabric off — the project remains an
   ordinary repository that plain Claude Code can work with.
4. **Transparency over autonomy.** Every agent step is visible and stoppable. Approvals
   for dangerous actions arrive as cards in the UI.
5. **Degrade gracefully.** Hit a limit — work pauses with a countdown, it doesn't
   crash. Server died — sessions recover via resume.

## What SuperFabric is NOT

- Not a cloud service and not a multi-tenant SaaS.
- Not a wrapper over API keys (we target subscriptions; API key is an optional
  fallback).
- Not a generic "any agent in the cloud" runner — Anthropic itself closed that niche
  (Claude Code on the web, Agent Teams). Our niche: **self-hosted control +
  multi-account visibility + spatial UX** that no one else has.

## Persona and scenario

A solo developer / tech lead with 2–3 Claude Max subscriptions runs a mid-size project
(5–10 services). In the morning they open SuperFabric: overnight the backend room closed
4 tasks, the notification room waits on an answer from payments, account #2 will hit its
weekly limit on Thursday. They answer two approval cards, tell the orchestrator "today's
priority is the payments integration", and go make coffee, glancing at the factory
floor.

## v1 success criteria

Checked against the code and the recorded acceptance runs on 2026-08-04. A box is ticked
only where there is evidence in [ROADMAP.md](ROADMAP.md), not where the feature merely
exists.

- [ ] **3 accounts × 3+ parallel agents work on one project for ≥ 8 hours without manual
      intervention.** *Never run.* The mechanism is built and tested, but the author has
      never had three logged-in subscriptions at once, and an eight-hour unattended run has
      not happened. This is the one criterion nothing has demonstrated.
- [x] **No session is lost on a server or container restart.** M0 proved it for host
      sessions (server SIGTERM'd mid-session, agent recalled a secret word afterwards); M4
      proved it for contained ones through a `kill -9`, with the same container re-adopted
      by its label.
- [x] **Per-account limits match the official `/usage` numbers; agents pause and resume
      automatically.** Live meters read from the endpoint in M2 (5-hour 49 %, weekly 88 %, a
      per-model window at 100 %); warn/pause/resume forced with a stubbed adapter on a fake
      clock, so no real limit was approached.
- [x] **A message from room A reaches room B in < 5 seconds, visibly on the canvas.** M3a,
      live: one operator prompt, `factory_send` with no approval card, the receiving agent
      picking it up as an injected turn, and a package on the belt each way.
- [x] **A fresh project gets onboarded (CLAUDE.md/README created by the interview agent) in
      a single session.** M1c, live: one interview, eight turns, $0.44, seven questions one
      at a time, both files written and five rooms proposed.
