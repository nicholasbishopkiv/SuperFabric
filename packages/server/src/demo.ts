import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROVIDER_CREDENTIALS_FILE } from "@superfabric/shared";
import type { AgentProvider, AutonomyMode, SessionEvent, TaskStatus, UsageWindow } from "@superfabric/shared";
import type { AccountManager } from "./accountManager.js";
import type { Chronicle } from "./chronicle.js";
import type { Db } from "./db.js";
import type { Executor, ExecutorEvents, ExecutorHandle, ExecutorStartOptions } from "./executor.js";
import type { FactoryBus } from "./factoryBus.js";
import type { ProjectManager } from "./projectManager.js";
import type { RoomManager } from "./roomManager.js";
import type { SessionManager } from "./sessionManager.js";
import type { TaskStore } from "./taskStore.js";

/**
 * Demo mode: a whole factory mid-week, and **no way to reach a real CLI from it**.
 *
 * It exists so the README can show what this is, and so anyone can see the product working before
 * installing anything. The property that makes it safe to ship is negative and is enforced rather
 * than promised: in demo mode the only `Executor` `SessionManager` is given is `DemoExecutor`, which
 * spawns no process, opens no socket and holds no credential. Nothing in this file imports
 * `ClaudeCodeExecutor`, `CodexExecutor` or `node:child_process`, and `index.ts` swaps the executors
 * at the single place one is chosen. There is no path from a demo agent to a subscription.
 *
 * Three more rules keep it honest:
 *
 * - **It never touches the operator's files.** The seeded project root is a fresh temp directory, so
 *   every folder this creates is under `/tmp` — not somebody's repository.
 * - **It says what it is.** Every agent's log opens with a line saying the work is simulated, the
 *   accounts are labelled `demo ·`, and the project's own `CLAUDE.md` says so too. A screenshot of
 *   this cannot be mistaken for a claim about a real run, including by whoever took it.
 * - **It goes through the ordinary paths.** Rooms are made by `RoomManager.createRoom`, agents by
 *   `SessionManager.createSession`, traffic by `FactoryBus.send`, decisions by `Chronicle.record`.
 *   A demo assembled by writing rows directly would be a picture of a factory this code cannot
 *   actually produce — which is the one thing a screenshot must never be.
 */

/** How long a simulated turn takes. Long enough to watch, short enough that the floor keeps moving. */
const TURN_MS = 4200;
/** How often the director stirs the factory. */
const TICK_MS = 3400;

/**
 * What a simulated turn costs, in the same units `turn_complete.costUsd` carries.
 *
 * The demo *simulates the CLI*, and a cost-equivalent is something the CLI reports — so leaving it
 * out would hide a panel rather than avoid inventing a number. It is still not a price list: nothing
 * multiplies tokens by a rate, here or anywhere else in the product.
 */
const TURN_COST = [0.021, 0.048, 0.013, 0.066, 0.032, 0.019];

export class DemoExecutor implements Executor {
  readonly name = "demo";
  private turns = 0;

  start(opts: ExecutorStartOptions, events: ExecutorEvents): ExecutorHandle {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, fn: () => void): void => {
      const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
      t.unref?.();
      timers.add(t);
    };
    let stopped = false;

    events.onEvent({
      type: "session_status",
      status: "starting",
      detail: "demo mode — this agent is simulated. No CLI is started, no subscription is spent, and "
        + "nothing outside this factory's temporary folder is touched.",
    });
    later(200, () => events.onEvent({ type: "session_status", status: "idle" }));

    return {
      providerSessionId: Promise.resolve(`demo-${opts.sessionKey ?? "session"}`),
      send: (text: string) => {
        if (stopped) return;
        const turn = this.turns++;
        events.onEvent({ type: "user_prompt", text });
        events.onEvent({ type: "session_status", status: "working" });
        // One gated call, on the prompt that asks for it. The turn genuinely *waits* on the
        // operator, exactly as a real one does — so the card in the console is not a picture of an
        // approval, it is an approval.
        if (text.toLowerCase().includes("migration")) {
          void events.requestApproval("Bash", { command: "pnpm -F payments migrate:up" }).then((behavior) => {
            if (stopped) return;
            events.onEvent({
              type: "agent_text",
              text: behavior === "allow"
                ? "Migration applied. The payments table has the idempotency index now."
                : "Understood — leaving the migration alone.",
            });
            events.onEvent({ type: "turn_complete", costUsd: 0.011 });
            events.onEvent({ type: "session_status", status: "idle" });
          });
          return;
        }
        const steps = scriptFor(text, opts.cwd);
        const gap = Math.floor(TURN_MS / (steps.length + 1));
        steps.forEach((step, i) => {
          later(gap * (i + 1), () => {
            if (stopped) return;
            for (const event of step) events.onEvent(event);
          });
        });
        later(TURN_MS, () => {
          if (stopped) return;
          events.onEvent({ type: "turn_complete", costUsd: TURN_COST[turn % TURN_COST.length]! });
          events.onEvent({ type: "session_status", status: "idle" });
        });
      },
      interrupt: async () => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        events.onEvent({ type: "session_status", status: "idle" });
      },
      stop: async () => {
        stopped = true;
        for (const t of timers) clearTimeout(t);
        timers.clear();
      },
    };
  }

  /**
   * Raise one approval card on a live agent, so the demo shows the surface an attended agent
   * actually produces. Deliberately never resolved by the director: the point is the card, and the
   * operator clicking it is the demo.
   */
  static askApproval(events: ExecutorEvents): void {
    void events.requestApproval("Bash", { command: "pnpm -F @superfabric/payments migrate:up" });
  }
}

/** The work a simulated turn does, chosen from the prompt so the transcript reads like an answer. */
function scriptFor(prompt: string, cwd: string): SessionEvent[][] {
  const room = path.basename(cwd);
  const lower = prompt.toLowerCase();

  if (lower.includes("[factory bus]")) {
    return [
      [{ type: "agent_thinking" }],
      [{ type: "tool_use", toolName: "Grep", input: { pattern: "webhook", path: "src" } }],
      [{ type: "tool_result", toolName: "Grep", output: "src/webhooks/router.ts:14  export const routes = {" }],
      [{ type: "agent_text", text: "Answered on the bus: `refund.partial` carries the original charge id." }],
    ];
  }
  if (lower.includes("test")) {
    return [
      [{ type: "agent_text", text: `Running the suite for what I changed in ${room}.` }],
      [{ type: "tool_use", toolName: "Bash", input: { command: "pnpm test -- --filter payments" } }],
      [{ type: "tool_result", toolName: "Bash", output: "✓ 42 passed (42)\nDuration 1.9s" }],
      [{ type: "agent_text", text: "Green. Moving the card to review." }],
    ];
  }
  if (lower.includes("review")) {
    return [
      [{ type: "agent_text", text: "Reading the diff before I say anything about it." }],
      [{ type: "tool_use", toolName: "Read", input: { file_path: `${cwd}/src/index.ts` } }],
      [{ type: "tool_result", toolName: "Read", output: "export async function handler(req) { …" }],
      [{ type: "agent_text", text: "One thing: the retry path needs the idempotency key too." }],
    ];
  }
  return [
    [{ type: "agent_thinking" }],
    [{ type: "tool_use", toolName: "Read", input: { file_path: `${cwd}/CLAUDE.md` } }],
    [{ type: "tool_result", toolName: "Read", output: "# charter\n\n## Responsibility …" }],
    [{ type: "tool_use", toolName: "Edit", input: { file_path: `${cwd}/src/index.ts` } }],
    [{ type: "tool_result", toolName: "Edit", output: "1 edit applied" }],
    [{ type: "agent_text", text: `Done in ${room}, and recorded why in an ADR.` }],
  ];
}

export interface DemoDeps {
  db: Db;
  projects: ProjectManager;
  rooms: RoomManager;
  tasks: TaskStore;
  bus: FactoryBus;
  chronicle: Chronicle;
  accounts: AccountManager;
  sessions: SessionManager;
  /** Where the demo factory's folders go. A temp directory — never the operator's own repository. */
  root: string;
  log?: (line: string) => void;
}

/** One department of the demo factory. */
interface DemoRoom {
  name: string;
  summary: string;
  /** `container` on one room, so the sandboxed badge and the shield on the floor are both shown. */
  runtime?: "container";
  agents: { role?: string; provider?: AgentProvider; autonomy?: AutonomyMode }[];
}

/**
 * Eight rooms and thirteen agents: enough for the floor to look like a factory rather than a diagram,
 * and chosen so that every surface the product has is represented by something on screen.
 */
const ROOMS: DemoRoom[] = [
  {
    name: "backend",
    summary: "The API, the database, and everything that has to keep a promise to another service.",
    agents: [{ role: "backend" }, { role: "backend" }, { role: "qa", provider: "codex" }],
  },
  {
    name: "frontend",
    summary: "The web client: what a person actually sees, and how quickly they see it.",
    agents: [{ role: "frontend" }, { role: "designer" }],
  },
  {
    name: "payments",
    summary: "Billing, invoices, and the webhook contract the rest of the factory depends on.",
    // The one contained room: agents here reach this folder and this account, nothing else.
    runtime: "container",
    agents: [{ role: "backend", autonomy: "attended" }, { role: "security" }],
  },
  {
    name: "infra",
    summary: "Deploys, the gateway, and the alerts that wake somebody up.",
    agents: [{ role: "devops", autonomy: "bypass" }],
  },
  {
    name: "data",
    summary: "The warehouse, the nightly jobs, and the numbers the board argues about.",
    agents: [{ role: "data", provider: "codex" }],
  },
  {
    name: "docs",
    summary: "The manual, the changelog, and keeping both true.",
    agents: [{ role: "tech-writer" }],
  },
  {
    name: "research",
    summary: "Reads the papers so nobody else has to, and writes down what is worth trying.",
    agents: [{ role: "architect" }],
  },
  {
    // Deliberately empty: a room with nobody home is what stacks crates at its door, and that pile
    // is one of the things the floor exists to make obvious.
    name: "mobile",
    summary: "The app. Nobody is staffing it this week, which is exactly what the pile at its door means.",
    agents: [],
  },
];

const TASKS: { title: string; detail: string; room: string | null; status: TaskStatus }[] = [
  { title: "Idempotency keys on the payments webhook", detail: "A retry must not charge twice.", room: "payments", status: "in_progress" },
  { title: "Checkout: show the card the customer will actually be charged", detail: "", room: "frontend", status: "in_progress" },
  { title: "Rate-limit the public search endpoint", detail: "60/min per token, counted in the gateway.", room: "backend", status: "review" },
  { title: "Nightly revenue rollup is four hours late", detail: "Started on Tuesday. Probably the new partition key.", room: "data", status: "in_progress" },
  { title: "Write down the webhook contract", detail: "Payments answers, docs records.", room: "docs", status: "blocked" },
  { title: "Roll the gateway to the new TLS config", detail: "", room: "infra", status: "review" },
  { title: "Migrate the sessions table off the old index", detail: "", room: "backend", status: "done" },
  { title: "Ship the empty-state illustrations", detail: "", room: "frontend", status: "done" },
  { title: "Read up on merkle-tree audit logs", detail: "Is it worth it for our volume?", room: "research", status: "open" },
  { title: "Decide where scheduled jobs live", detail: "Nobody has routed this yet — the orchestrator will.", room: null, status: "open" },
];

/** Build the demo factory and set it going. Returns a stop handle. */
export function startDemo(deps: DemoDeps): { stop(): void } {
  const log = deps.log ?? (() => {});
  const project = deps.projects.create({ root: deps.root, name: "Payments Platform" });
  deps.projects.open(project.id);
  // A charter at the root, so the floor shows a factory at work rather than the onboarding offer —
  // first contact has its own demo, which is any real folder that has no `CLAUDE.md`.
  writeFileSync(path.join(deps.root, "CLAUDE.md"), DEMO_CHARTER);
  deps.rooms.ensureProjectRoom(project.id);

  const roomIds = new Map<string, string>();
  const agentIds: string[] = [];
  /** The one agent created `attended`, which is the one whose gated call raises a card. */
  let attended: string | undefined;
  for (const spec of ROOMS) {
    const room = deps.rooms.createRoom(spec.name, { projectId: project.id, summary: spec.summary });
    roomIds.set(spec.name, room.id);
    if (spec.runtime === "container") deps.rooms.setRuntime(room.id, "container");
    for (const agent of spec.agents) {
      const id = deps.sessions.createSession({
        roomId: room.id,
        projectId: project.id,
        ...(agent.role !== undefined ? { roleId: agent.role } : {}),
        ...(agent.provider !== undefined ? { provider: agent.provider } : {}),
        ...(agent.autonomy !== undefined ? { autonomy: agent.autonomy } : {}),
      });
      agentIds.push(id);
      if (agent.autonomy === "attended") attended = id;
    }
  }

  // The senior agent, in the project room — the same session `ensure_orchestrator` would create.
  const projectRoom = deps.rooms.ensureProjectRoom(project.id);
  const orchestrator = deps.sessions.createSession({
    roomId: projectRoom.id, projectId: project.id, isOrchestrator: true,
  });

  const taskIds = new Map<string, string>();
  for (const card of TASKS) {
    const created = deps.tasks.create({
      title: card.title, detail: card.detail, projectId: project.id,
      ...(card.room === null ? {} : { roomId: roomIds.get(card.room)! }),
    });
    if (card.status !== "open") deps.tasks.update(created.id, { status: card.status });
    taskIds.set(card.title, created.id);
  }

  seedTraffic(deps, roomIds);
  seedDecisions(deps, project.id, roomIds);
  seedAccountsAndMeters(deps);

  // One agent held by a limit, so the paused colour, the badge and the countdown are all on screen —
  // through the ordinary pause path, at a turn boundary, exactly as the scheduler would.
  const held = agentIds.at(-2);
  if (held !== undefined) {
    void deps.sessions.pauseSession(held, Math.floor(Date.now() / 1000) + 2_400,
      "demo: this account's 5-hour window is full — it comes back when the window rolls");
  }

  // One attended agent is asked to do something gated, once and by id rather than by whoever happens
  // to be free — an approval card is a surface worth seeing, and "if someone is idle" is exactly how
  // a demo ends up not showing it.
  if (attended !== undefined) {
    const ask = setTimeout(() => deps.sessions.prompt(attended, "run the pending migration on payments"), 4_000);
    ask.unref?.();
  }

  const director = new Director(deps, roomIds, taskIds, orchestrator);
  director.start();
  log(`demo factory "${project.name}" ready: ${ROOMS.length + 1} rooms, ${agentIds.length + 1} agents`);
  log(`demo root: ${deps.root} (temporary — nothing outside it is touched)`);
  return { stop: () => director.stop() };
}

/**
 * What makes the floor *move*: messages between rooms, agents taking turns, cards changing column.
 *
 * A class rather than a closure because it holds a tick counter and a timer, and because "the demo
 * pretends to be an operator" is a thing worth naming. Everything it does goes through the same
 * managers a real operator's clicks would.
 */
class Director {
  private tick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private deps: DemoDeps,
    private roomIds: Map<string, string>,
    private taskIds: Map<string, string>,
    private orchestrator: string,
  ) {}

  start(): void {
    this.stir();
    this.timer = setInterval(() => {
      try { this.stir(); }
      catch (err) { this.deps.log?.(`demo: ${String(err)}`); }
    }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private stir(): void {
    const tick = this.tick++;
    const names = [...this.roomIds.keys()];
    const from = this.roomIds.get(names[tick % names.length]!)!;
    const to = this.roomIds.get(names[(tick * 3 + 1) % names.length]!)!;

    // A package on the belt. Sent every tick, because traffic is what the conveyors draw.
    if (from !== to) {
      this.deps.bus.send({
        fromRoomId: from, toRoomId: to, kind: tick % 3 === 0 ? "response" : "request",
        body: ASKS[tick % ASKS.length]!,
      });
    }

    // Two rooms get on with their own work each tick, so several chimneys are lit at once.
    for (const name of [names[(tick * 2) % names.length]!, names[(tick * 5 + 3) % names.length]!]) {
      const roomId = this.roomIds.get(name)!;
      const free = this.deps.sessions.roomAgents(roomId).find((a) => a.status === "idle");
      if (free === undefined) continue;
      this.deps.sessions.prompt(free.sessionId, PROMPTS[tick % PROMPTS.length]!);
    }

    // The orchestrator answers the unrouted card, a few ticks in — the demo standing in for a model
    // decision, which is the one thing here that cannot be simulated by running the real path.
    if (tick === 3) {
      const unrouted = this.taskIds.get("Decide where scheduled jobs live");
      if (unrouted !== undefined) {
        this.deps.sessions.prompt(this.orchestrator, "where do scheduled jobs belong? review the floor");
        this.deps.tasks.update(unrouted, { roomId: this.roomIds.get("infra")!, status: "in_progress" });
      }
    }

    // And the board moves: a card advances every few ticks, which is what a week actually looks like.
    if (tick > 0 && tick % 4 === 0) {
      const moving = [...this.taskIds.values()][(tick / 4) % this.taskIds.size]!;
      const current = this.deps.tasks.get(moving);
      if (current !== undefined) {
        const next: Record<TaskStatus, TaskStatus> = {
          open: "in_progress", in_progress: "review", review: "done", blocked: "in_progress", done: "done",
        };
        this.deps.tasks.update(moving, { status: next[current.status] });
      }
    }
  }
}

const ASKS = [
  "Can you confirm the field name before I write it down?",
  "This touches your folder — is the change safe from your side?",
  "I need one number from you: what timeout do you actually use?",
  "Ready for review whenever you are.",
  "The migration is queued behind yours; say when.",
  "Answered — see the ADR I just recorded.",
];

const PROMPTS = [
  "carry on with the card you are holding",
  "run the tests for what you changed",
  "review the diff on the branch",
  "write the section of the manual this needs",
];

/** Traffic already on the floor when the demo opens, including a pile nobody has collected. */
function seedTraffic(deps: DemoDeps, roomIds: Map<string, string>): void {
  const at = (name: string): string => roomIds.get(name)!;
  deps.bus.send({ fromRoomId: at("frontend"), toRoomId: at("payments"), kind: "request", body: "What does the webhook send on a partial refund?" });
  deps.bus.send({ fromRoomId: at("payments"), toRoomId: at("frontend"), kind: "response", body: "`refund.partial`, with the original charge id and the remaining balance." });
  deps.bus.send({ fromRoomId: at("docs"), toRoomId: at("backend"), kind: "request", body: "Is the search rate limit per token or per IP? The manual has to say." });
  // Three for the room nobody is staffing: this is the pile at the door.
  deps.bus.send({ fromRoomId: at("backend"), toRoomId: at("mobile"), kind: "request", body: "The session endpoint changed shape — does the app read `expires_at`?" });
  deps.bus.send({ fromRoomId: at("frontend"), toRoomId: at("mobile"), kind: "info", body: "New empty-state illustrations are in the design folder." });
  deps.bus.send({ fromRoomId: at("infra"), toRoomId: at("mobile"), kind: "request", body: "Can the app tolerate a 30s gateway restart on Thursday?" });
}

/** A few real ADRs, so the chronicle has something to find. Written into the demo's own temp project. */
function seedDecisions(deps: DemoDeps, projectId: string, roomIds: Map<string, string>): void {
  deps.chronicle.record({
    projectId, roomId: roomIds.get("payments")!,
    title: "Webhooks are idempotent by key, not by payload",
    context: "Retries were charging twice under network partitions.",
    decision: "Every webhook carries an idempotency key; payments stores it for 24h and answers the second delivery from the record.",
    alternatives: "Deduplicating on a payload hash — rejected: two legitimate identical charges exist.",
  });
  deps.chronicle.record({
    projectId, roomId: roomIds.get("backend")!,
    title: "Rate limits are per token, per minute",
    context: "The public search endpoint was being scraped from one account across many addresses.",
    decision: "60 requests per minute per API token, counted in the gateway.",
    alternatives: "Per IP — rejected: it punishes offices and does nothing about one token behind many addresses.",
  });
  deps.chronicle.record({
    projectId, roomId: roomIds.get("data")!,
    title: "The warehouse is partitioned by day, not by tenant",
    context: "The nightly rollup was scanning every tenant's history to answer one day's question.",
    decision: "Partition on the event date; tenant stays a clustering key.",
    alternatives: "Per-tenant tables — rejected: 4,000 tables and no way to ask a cross-tenant question.",
  });
}

/**
 * Two accounts with a *history* of readings, so the meters and the burn-rate projection both fill.
 *
 * The snapshots are written straight into `usage_snapshots`, and this is the one place the demo is a
 * fixture rather than the product's own path — deliberately, because the alternative is a network
 * call to somebody's real subscription. The series rises over an hour so the projection has a slope
 * to measure; the burn rate is then computed by the ordinary `MetricsStore`, not faked.
 */
function seedAccountsAndMeters(deps: DemoDeps): void {
  const insert = deps.db.prepare(
    "INSERT INTO usage_snapshots (account_id, read_at, source, approximate, windows, note, limited, limited_until, limited_by)"
    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const now = Math.floor(Date.now() / 1000);
  const accounts: { label: string; provider: AgentProvider; from: number; to: number; weekly: number }[] = [
    { label: "demo · work", provider: "claude", from: 41, to: 68, weekly: 37 },
    { label: "demo · openai", provider: "codex", from: 12, to: 24, weekly: 9 },
  ];

  for (const spec of accounts) {
    const dir = path.join(deps.root, ".demo-accounts", spec.label.replace(/[^a-z0-9]+/gi, "-"));
    mkdirSync(dir, { recursive: true });
    // A placeholder credentials file, so a demo account reads as what it is *inside the simulation*:
    // one an agent can run on. It holds no token and unlocks nothing — the executors in this mode
    // are the simulator, and none of them looks at a directory at all.
    writeFileSync(path.join(dir, PROVIDER_CREDENTIALS_FILE[spec.provider]), '{"demo": true}\n');
    const account = deps.accounts.create({ label: spec.label, configDir: dir, provider: spec.provider });
    // Six readings over the last hour: enough span and enough points for a real least-squares slope.
    for (let i = 5; i >= 0; i--) {
      const readAt = now - i * 600;
      const share = (5 - i) / 5;
      const windows: UsageWindow[] = [
        {
          key: "five_hour", label: "5-hour",
          utilization: Math.round(spec.from + (spec.to - spec.from) * share),
          resetsAt: new Date((now + 9_000) * 1000).toISOString(), detail: null,
        },
        {
          key: "seven_day", label: "weekly", utilization: spec.weekly,
          resetsAt: new Date((now + 380_000) * 1000).toISOString(), detail: null,
        },
      ];
      insert.run(account.id, readAt, "endpoint", 0, JSON.stringify(windows), null, 0, null, null);
    }
  }
}

const DEMO_CHARTER = `# Payments Platform — a SuperFabric demo

A made-up product, used to show what a SuperFabric factory looks like while it is working.

**Everything here is simulated.** No CLI is started, no subscription is spent, and nothing outside
this temporary folder is touched. The rooms, the agents, the board, the traffic on the belts and the
meters are all produced by the product's own code paths — only the agents' answers are scripted.

## Rooms

- **backend** — the API and the database.
- **frontend** — the web client.
- **payments** — billing and the webhook contract. Contained: its agents reach this folder and one
  account, nothing else.
- **infra** — deploys, the gateway, the alerts.
- **data** — the warehouse and the nightly jobs.
- **docs** — the manual, kept true.
- **research** — reads the papers, writes down what is worth trying.
- **mobile** — nobody is staffing it this week; that is what the pile at its door means.
`;
