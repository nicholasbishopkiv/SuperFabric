# SuperFabric — Product Vision

> 🇷🇺 Русский оригинал: [VISION.ru.md](VISION.ru.md)

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
> Agents are created from a **roles library**: dozens of ready presets (architect,
> designer, backend developer, QA, DevOps, tech writer…), where a role = a system prompt
> + recommended skills/superpowers + plugins and MCP servers + a recommended model. Pick
> a role and SuperFabric offers to attach the whole bundle — no need to understand
> skills and configs. Presets are customizable and shareable.
>
> Departments exchange tasks and questions through the **factory MCP bus** (the chat
> room asks the payments room for push-notification webhooks — and receives the answer
> when the work is done). The **orchestrator** is the senior agent in the headquarters
> building: it distributes work, clears blockers, makes technical direction decisions,
> and junior agents come to it for research and rulings.
>
> Accounts are added right from the UI: the **"Add session"** button opens an embedded
> terminal where the user logs into a Claude account; every new room or agent is then
> bound to one of the registered accounts. Claude Code is the first supported engine;
> the core is built against an **executor abstraction**, so other agents (Codex /
> ChatGPT agents, Antigravity, …) plug in later — different strengths for different
> tasks.
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
> them, and automatically resumes sessions from the same spot after reset. Sessions
> survive restarts: all state is cached and restored.

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

- [ ] 3 accounts × 3+ parallel agents work on one project for ≥ 8 hours without manual
      intervention.
- [ ] No session is lost on a server or container restart.
- [ ] Per-account limits match the official `/usage` numbers; agents pause and resume
      automatically.
- [ ] A message from room A reaches room B in < 5 seconds, visibly on the canvas.
- [ ] A fresh project gets onboarded (CLAUDE.md/README created by the interview agent)
      in a single session.
