# M5 — The living factory, metrics and portability

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** The last milestone. The factory stops looking like a diagram that updates and starts looking like a place where work happens: agents walk to the loading bay when a package arrives and carry it in, chimneys smoke while a room is working, windows light when someone is inside. Plus the two remaining utilities — per-account burn-rate metrics, and exporting a factory so it can be moved or shared.

**A deliberate change from the earlier roadmap:** M5 was going to buy glTF characters. It ships **procedural motion tied to real state** instead. The operator asked for "small agents that do something there" — the value is in the *doing*, and animation driven by the event log is both more informative and more impressive than a static purchased mesh. It also avoids sourcing and licensing third-party character assets for an MIT repo. The figures already have legs, torso, arms and a hard hat; this milestone makes them act.

**Architecture:** All of the motion is client-side, derived from state the store already has — no new server surface for Task 1 or 2. The frameloop contract stays the single animation gate: anything that moves must be reflected in `hasMotion`, and an idle factory must still do zero `requestAnimationFrame` calls.

**Conventions:** server tests `bun test`, web/shared vitest, installs pnpm. Never set `SUPERFABRIC_LIVE_TEST=1`; never prompt a real agent. Commit per task.

---

### Task 1: Agents that do something

- [ ] **Fetch a package.** When a package arrives on a belt into a room, one of that room's agents walks from its post to the loading bay the belt enters, meets it, and walks back carrying it (the crate rides at its side). If no agent is free, the crate waits at the bay — a room with nobody home visibly piles up, which is information the operator wants.
- [ ] **Post and gait.** Agents stand at posts in an arc; walking is a path between post and bay, with the existing arm-swing and step bob driving along it rather than in place. Turn to face the direction of travel.
- [ ] **Blocked agents look blocked.** An agent waiting on an approval should read as waiting — facing the operator's camera, still, distinct from idle.
- [ ] Tests: the pure path/scheduling helpers (which agent is chosen, where the path runs, what happens when none is free, what happens when a package arrives for an empty room). Do not try to mount `<Canvas>` in jsdom — the established pattern is to extract the maths and test that.

### Task 2: A factory that looks inhabited

- [ ] **Chimney smoke while a room is working** — a cheap instanced particle plume from the roof vents, fading out when the room goes idle.
- [ ] **Windows light** when a room has a live agent, dark when it does not. The warm interior glow already exists; make it conditional.
- [ ] **Belt slats crawl** while a package is on that belt, still otherwise.
- [ ] Keep it quiet. The belts, the packages and the status beacons must remain the most readable things on screen; this is atmosphere, not competition. If an effect makes the floor harder to read, drop it and say so.
- [ ] The `hasMotion` gate must account for every one of these. Verify rAF is 0 with a fully idle factory and non-zero when a chimney is smoking.

### Task 3: Burn-rate metrics

- [ ] Per account: tokens and cost-equivalent over time, and a burn rate with a projection to the next limit — the number an operator actually acts on is "at this rate you have two hours".
- [ ] Source it from what already exists: `turn_complete` carries `costUsd`, `span`-style usage is in the event log, and `usage_snapshots` holds the real utilisation history. **Do not invent a pricing table** — if a cost needs per-model rates, take them from a single documented constant with its source noted, and label anything derived as an estimate.
- [ ] Surface in the accounts popover beside the existing meters. Approximate numbers stay visibly approximate — that rule is already established and must hold here.
- [ ] Tests: burn rate from a synthetic snapshot series; a projection that says "unknown" rather than guessing when there is too little history; cost aggregation per account and per room.

### Task 4: Export and import a factory

- [ ] `export_project {projectId}` produces a single portable file describing the factory: rooms (name, folder, position, runtime, account binding by *label* not id), agents (role, model, autonomy), tasks, and the decision index — enough to rebuild the floor elsewhere.
- [ ] **Do not export secrets.** No tokens, no `.credentials.json`, no config-dir contents. Accounts are referenced by label and must be re-bound on import; say so in the file and in the UI.
- [ ] Import into a chosen project root: create rooms through the ordinary `createRoom` path so every invariant applies, report what it could not do (a missing account label, a folder that already exists) rather than silently skipping.
- [ ] Tests: round-trip a factory; an import into a root with an existing room reports the collision; no secret material appears anywhere in the exported bytes (assert that explicitly — grep the output for the token shapes).

### Task 5: Final pass

- [ ] Acceptance: a populated factory, a package fetched by an agent, smoke while working, metrics showing, an export imported into a fresh project.
- [ ] **Documentation truth pass.** Read `README.md`, `docs/VISION.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` and `CLAUDE.md` against what the code now does, and fix anything that has drifted. Every milestone added to these; nobody has read them end to end since M0. Report what was stale.
- [ ] Mark the roadmap complete through M5 and state plainly what is *not* built (there will be things — say them).

---

## Self-review notes

- **Covers** the remaining M5 items from the roadmap, with the glTF decision consciously changed and the reason recorded.
- **Not covered, and should be stated rather than quietly dropped**: phone push notifications, the 50-role expansion (11 ship; the format is extensible and that is the honest version), and multi-provider executors (post-v1 by design — the seam exists).
- **Risk**: atmosphere effects are the easiest place to make a legible screen illegible. Task 2 says drop anything that hurts readability, and that instruction is the point, not a caveat.
