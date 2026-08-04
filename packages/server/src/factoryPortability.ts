import { existsSync } from "node:fs";
import path from "node:path";
import {
  FACTORY_EXPORT_FORMAT,
  FACTORY_EXPORT_NOTE,
  FACTORY_EXPORT_VERSION,
  FactoryExport,
  type ExportedAgent,
  type ExportedDecision,
  type ExportedRoom,
  type ExportedTask,
  type FactoryImportResult,
  type RoomInfo,
} from "@superfabric/shared";
import type { AccountManager } from "./accountManager.js";
import type { Chronicle } from "./chronicle.js";
import type { Db } from "./db.js";
import type { ProjectManager } from "./projectManager.js";
import type { RoomManager } from "./roomManager.js";
import type { TaskStore } from "./taskStore.js";

/**
 * Moving a factory: writing one out, and building one back.
 *
 * **Two properties are the whole of this file, and both are enforced rather than promised.**
 *
 * 1. **Nothing secret leaves.** An account appears only as the label the operator typed. No token, no
 *    `.credentials.json`, nothing read from any `CLAUDE_CONFIG_DIR`, and — a deliberate second line —
 *    **no absolute path at all**, because a room's folder on this machine is neither portable nor
 *    anyone else's business. `test/factoryPortability.test.ts` greps the serialised bytes for the
 *    token shapes and for every configured config directory and fails if it finds one.
 * 2. **An import goes through the ordinary `createRoom`.** Name safety, root containment and the
 *    never-overwrite-a-charter rule all still hold *because it is the same code path* — not because
 *    this file remembered to re-check them. And everything it could not do is named in `problems`: a
 *    partial import that claims to be complete is worse than a refused one, because the operator would
 *    go looking for a room that is not there.
 *
 * What an import deliberately does **not** do is start agents. A session's conversation lives in its
 * account's transcripts, so a `claude_session_id` from another machine resolves to nothing; and
 * spawning a CLI (or a container) per described agent the moment a file is opened is not a thing an
 * operator asked for. The staffing is reported instead, and creating it is one click in the room panel.
 */

/** Row shape of the session query the export reads. Agents, as the rows describe them. */
interface AgentRow {
  room_id: string | null;
  role_id: string | null;
  model: string | null;
  autonomy: string;
  account_id: string | null;
  is_orchestrator: number;
  state: string;
}

/** Row shape of the decision query. */
interface DecisionRow {
  number: number;
  title: string;
  path: string;
  room_id: string | null;
  created_at: number;
}

export interface PortabilityDeps {
  db: Db;
  projects: ProjectManager;
  rooms: RoomManager;
  accounts: AccountManager;
  /** Absent => tasks are neither exported nor imported, which is a valid pre-M3a-shaped server. */
  tasks?: TaskStore;
  /** Absent => the decision index is neither exported nor imported. */
  chronicle?: Chronicle;
  /** Seam: an export stamps the moment it was taken. */
  now?: () => number;
}

/**
 * The two operations, as one object the hub can hold.
 *
 * A class over the same functions, for the reason every other collaborator in this server is one: the
 * hub takes it as an option and a server without it simply refuses the two messages, rather than the
 * hub having to reach through `RoomManager` for a database handle it has no other use for.
 */
export class FactoryPortability {
  constructor(private deps: PortabilityDeps) {}

  export(projectId: string): FactoryExport {
    return exportFactory(this.deps, projectId);
  }

  import(opts: ImportFactoryOptions): FactoryImportResult {
    return importFactory(this.deps, opts);
  }
}

/**
 * One factory as a portable file.
 *
 * Rooms come back in floor order (the project room first), each carrying the agents that stood in it —
 * only the ones still alive, because a `done` or errored session is a historical fact about this
 * machine rather than a description of how the department is staffed.
 */
export function exportFactory(deps: PortabilityDeps, projectId: string): FactoryExport {
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const project = deps.projects.require(projectId);
  const root = project.root;
  const rooms = deps.rooms.listRooms(projectId);
  const byId = new Map(rooms.map((r) => [r.id, r]));

  const agents = deps.db.prepare(`
    SELECT room_id, role_id, model, autonomy, account_id, is_orchestrator, state
    FROM sessions WHERE project_id = ? ORDER BY created_at, rowid
  `).all(projectId) as AgentRow[];

  const labels = new Set<string>();
  const labelOf = (accountId: string | null): string | null => {
    if (accountId === null) return null;
    const label = deps.accounts.get(accountId)?.label ?? null;
    if (label !== null) labels.add(label);
    return label;
  };

  const agentsByRoom = new Map<string, ExportedAgent[]>();
  for (const row of agents) {
    // A stopped agent is not staffing. `active` and `paused` are both "this room has someone".
    if (row.state !== "active" && row.state !== "paused") continue;
    if (row.room_id === null || !byId.has(row.room_id)) continue;
    const list = agentsByRoom.get(row.room_id) ?? [];
    list.push({
      roleId: row.role_id,
      model: row.model,
      autonomy: row.autonomy === "attended" || row.autonomy === "bypass" ? row.autonomy : "auto",
      accountLabel: labelOf(row.account_id),
      isOrchestrator: row.is_orchestrator === 1,
    });
    agentsByRoom.set(row.room_id, list);
  }

  const exportedRooms: ExportedRoom[] = rooms.map((room) => ({
    name: room.name,
    kind: room.kind,
    relativePath: relativeToRoot(root, room.path),
    position: room.position,
    runtime: room.runtime,
    accountLabel: labelOf(room.accountId),
    agents: agentsByRoom.get(room.id) ?? [],
  }));

  const tasks: ExportedTask[] = (deps.tasks?.list(projectId) ?? [])
    // Oldest first, so an import rebuilds the board in the order it was filled.
    .slice()
    .reverse()
    .map((task) => ({
      title: task.title,
      detail: task.detail,
      status: task.status,
      roomName: task.roomId === null ? null : byId.get(task.roomId)?.name ?? null,
    }));

  const decisions: ExportedDecision[] = deps.chronicle === undefined ? [] : (deps.db.prepare(`
    SELECT number, title, path, room_id, created_at FROM decisions
    WHERE project_id = ? ORDER BY number, rowid
  `).all(projectId) as DecisionRow[]).flatMap((row) => {
    const relative = relativeToRoot(root, row.path);
    // An ADR written outside the project root cannot be pointed at portably. It is a real (if odd)
    // state — the row records whatever path was written — and dropping it silently would make the
    // index claim a decision count the file list does not support, so it is simply not exported.
    if (relative === null) return [];
    return [{
      number: row.number,
      title: row.title,
      relativePath: relative,
      roomName: row.room_id === null ? null : byId.get(row.room_id)?.name ?? null,
      createdAt: row.created_at,
    }];
  });

  return {
    format: FACTORY_EXPORT_FORMAT,
    version: FACTORY_EXPORT_VERSION,
    exportedAt: now(),
    note: FACTORY_EXPORT_NOTE,
    project: { name: project.name },
    accountLabels: [...labels].sort(),
    rooms: exportedRooms,
    tasks,
    decisions,
  };
}

export interface ImportFactoryOptions {
  /** Absolute path of an existing directory: where the factory is rebuilt. */
  root: string;
  /** Display name for a project this import creates. Ignored when the root already has one. */
  name?: string;
  /** The file, unparsed. Validated here so a bad one is refused by name. */
  factory: unknown;
}

/**
 * Rebuild a factory in a folder the operator named.
 *
 * Order matters: the project (and its central building) first, then rooms, then the board and the
 * decision index, which both refer to rooms by name. A failure anywhere is a line in `problems` and
 * never an abandoned half-import — every step is independent, and the result says exactly what landed.
 */
export function importFactory(deps: PortabilityDeps, opts: ImportFactoryOptions): FactoryImportResult {
  const parsed = FactoryExport.safeParse(opts.factory);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`)
      .slice(0, 5)
      .join("; ");
    throw new Error(`this is not a SuperFabric factory export: ${issues}`);
  }
  const factory = parsed.data;

  const root = path.resolve(opts.root.trim());
  const existing = deps.projects.byRoot(root);
  const project = existing ?? deps.projects.create({
    root,
    // The exported name, unless the operator typed one. A factory that arrives calling itself
    // "payments-platform" should still say so on the switcher.
    name: (opts.name ?? "").trim() || factory.project.name,
  });
  deps.rooms.ensureProjectRoom(project.id);

  const problems: string[] = [];
  const roomsCreated: string[] = [];
  const byName = new Map<string, RoomInfo>(
    deps.rooms.listRooms(project.id).map((r) => [r.name, r]),
  );

  // Account labels first, so a missing one is reported once rather than once per room that wanted it.
  const accountByLabel = new Map<string, string>();
  for (const account of deps.accounts.list()) accountByLabel.set(account.label, account.id);
  for (const label of factory.accountLabels) {
    if (!accountByLabel.has(label)) {
      problems.push(
        `no account on this machine is labelled ${JSON.stringify(label)} — whatever referred to it `
        + "was imported unbound, and will run on the ambient ~/.claude until you add that account and "
        + "bind it",
      );
    }
  }

  let agentsDescribed = 0;
  for (const room of factory.rooms) {
    agentsDescribed += room.agents.length;
    // The central building is created by `ensureProjectRoom` from the new root, and its folder *is*
    // that root. Re-creating it would either duplicate it or refuse; carrying its position over is
    // the only part worth doing.
    if (room.kind === "project") {
      const projectRoom = deps.rooms.listRooms(project.id).find((r) => r.kind === "project");
      if (projectRoom !== undefined) {
        deps.rooms.moveRoom(projectRoom.id, room.position);
        byName.set(projectRoom.name, deps.rooms.getRoom(projectRoom.id)!);
      }
      continue;
    }

    if (room.relativePath !== null && room.relativePath !== room.name) {
      // A nested or renamed folder. `createRoom` resolves `<root>/<name>` on its own and an explicit
      // path is the only way past containment, so rather than hand it one we say what changed.
      problems.push(
        `room ${JSON.stringify(room.name)} lived in ${room.relativePath} on the exporting machine; `
        + `it now lives in ${room.name}`,
      );
    }
    if (room.relativePath === null) {
      problems.push(
        `room ${JSON.stringify(room.name)} lived outside the exporting project's root, so its folder `
        + `could not be described portably; it now lives in ${room.name} — re-point it if that is wrong`,
      );
    }

    let created: RoomInfo;
    try {
      created = deps.rooms.createRoom(room.name, { projectId: project.id });
    } catch (err) {
      problems.push(`room ${JSON.stringify(room.name)} was not created: ${messageOf(err)}`);
      continue;
    }
    roomsCreated.push(created.name);

    deps.rooms.moveRoom(created.id, room.position);
    deps.rooms.setRuntime(created.id, room.runtime);
    if (room.accountLabel !== null) {
      const accountId = accountByLabel.get(room.accountLabel);
      if (accountId !== undefined) deps.rooms.setAccount(created.id, accountId);
    }
    byName.set(created.name, deps.rooms.getRoom(created.id)!);
  }

  let tasksCreated = 0;
  if (deps.tasks === undefined) {
    if (factory.tasks.length > 0) {
      problems.push(
        `${factory.tasks.length} task(s) were in the file but this server has no task board`,
      );
    }
  } else {
    for (const task of factory.tasks) {
      const room = task.roomName === null ? undefined : byName.get(task.roomName);
      if (task.roomName !== null && room === undefined) {
        problems.push(
          `task ${JSON.stringify(task.title)} was assigned to room ${JSON.stringify(task.roomName)}, `
          + "which is not on this floor — it was created unassigned",
        );
      }
      try {
        const card = deps.tasks.create({
          title: task.title,
          detail: task.detail,
          projectId: project.id,
          ...(room !== undefined ? { roomId: room.id } : {}),
        });
        // Created `open` and then moved, because a card's status is a fact about the work rather than
        // something `create` takes — the same route the board's own drag uses.
        if (task.status !== "open") deps.tasks.update(card.id, { status: task.status });
        tasksCreated++;
      } catch (err) {
        problems.push(`task ${JSON.stringify(task.title)} was not created: ${messageOf(err)}`);
      }
    }
  }

  let decisionsIndexed = 0;
  if (deps.chronicle === undefined) {
    if (factory.decisions.length > 0) {
      problems.push(
        `${factory.decisions.length} recorded decision(s) were in the file but this server has no `
        + "chronicle",
      );
    }
  } else {
    for (const decision of factory.decisions) {
      const file = path.resolve(root, decision.relativePath);
      // The invariant, still holding: a decision is a file and the row is an index over it. If the
      // repository being imported into does not hold the ADR, there is nothing to index — and saying
      // so is far better than an index entry pointing at a file that is not there.
      if (!existsSync(file)) {
        problems.push(
          `decision ${String(decision.number).padStart(4, "0")} `
          + `(${JSON.stringify(decision.title)}) was not indexed: ${decision.relativePath} is not in `
          + "this repository — the ADR file is the artefact, and the index never invents one",
        );
        continue;
      }
      try {
        deps.chronicle.indexImported({
          projectId: project.id,
          roomId: decision.roomName === null ? null : byName.get(decision.roomName)?.id ?? null,
          number: decision.number,
          file,
          title: decision.title,
          createdAt: decision.createdAt,
        });
        decisionsIndexed++;
      } catch (err) {
        problems.push(
          `decision ${String(decision.number).padStart(4, "0")} was not indexed: ${messageOf(err)}`,
        );
      }
    }
  }

  if (agentsDescribed > 0) {
    problems.push(
      `${agentsDescribed} agent(s) were described in the file and none were started — a conversation `
      + "does not travel with an export, so the staffing is yours to recreate from the room panel",
    );
  }

  return {
    projectId: project.id,
    projectName: project.name,
    projectCreated: existing === undefined,
    roomsCreated,
    tasksCreated,
    decisionsIndexed,
    agentsDescribed,
    problems,
  };
}

/**
 * A path inside the root, as a POSIX-relative string — or null when it is not inside it.
 *
 * The root itself is `"."`, which is what the central building's folder is. Windows separators are
 * folded to `/` so a file written on one platform reads on another; nothing here ever *builds* a path
 * from this, so it is a description rather than an instruction.
 */
export function relativeToRoot(root: string, target: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved === resolvedRoot) return ".";
  if (!resolved.startsWith(resolvedRoot + path.sep)) return null;
  return path.relative(resolvedRoot, resolved).split(path.sep).join("/");
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
