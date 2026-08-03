# M1a — Rooms and the 3D Factory Floor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rooms exist as first-class objects backed by project folders, and the browser shows them as an isometric 3D factory floor — a central project building, one workshop per room, conveyors between them carrying package meshes when something flows, and a figure per agent whose motion reflects that agent's real status.

**Architecture:** Rooms live in SQLite (`rooms` table, migration 3) and on disk (a folder per room with a `CLAUDE.md` charter). Sessions gain `room_id`. The existing WebSocket protocol grows room messages; the event log stays the source of truth. The web package adds a react-three-fiber scene as the primary surface, with the existing M0 console demoted to a 2D overlay drawer. Scene state comes from zustand per-object selectors — never `node.data`-style prop drilling — so a status tick re-renders one building, not the tree.

**Tech Stack:** three, @react-three/fiber, @react-three/drei (all MIT), zustand, React 19, Vite, vitest.

**Conventions:** ESM; run commands from the repo root; `pnpm -F @superfabric/<pkg> test`; commit after every green step; never commit scratch files (use /tmp). **Never run with `SUPERFABRIC_LIVE_TEST=1` and never prompt a real agent — that spends the user's subscription quota.** Use `FakeExecutor` / the injected `query` seam.

---

### Task 1: Rooms in the protocol

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Test: `packages/shared/test/protocol.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { RoomInfo, ClientMessage, ServerMessage } from "../src/protocol.js";

it("parses a room info object", () => {
  const r = RoomInfo.parse({
    id: "r1", name: "backend", path: "/p/backend",
    position: { x: 3, z: -2 }, kind: "room", agentCount: 0,
  });
  expect(r.kind).toBe("room");
});

it("defaults a room's position to the origin", () => {
  const r = RoomInfo.parse({ id: "r1", name: "backend", path: "/p/backend", kind: "room", agentCount: 0 });
  expect(r.position).toEqual({ x: 0, z: 0 });
});

it("parses room client messages", () => {
  expect(ClientMessage.parse({ kind: "create_room", name: "payments" }).kind).toBe("create_room");
  expect(ClientMessage.parse({ kind: "move_room", roomId: "r1", position: { x: 1, z: 2 } }).kind).toBe("move_room");
  expect(ClientMessage.parse({ kind: "list_rooms" }).kind).toBe("list_rooms");
});

it("rejects a room name that is not a safe folder segment", () => {
  expect(() => ClientMessage.parse({ kind: "create_room", name: "../escape" })).toThrow();
  expect(() => ClientMessage.parse({ kind: "create_room", name: "has/slash" })).toThrow();
  expect(() => ClientMessage.parse({ kind: "create_room", name: "" })).toThrow();
});

it("parses a rooms server message", () => {
  const m = ServerMessage.parse({ kind: "rooms", rooms: [] });
  expect(m.kind).toBe("rooms");
});
```

- [ ] **Step 2: Run** `pnpm -F @superfabric/shared test` — expect FAIL.

- [ ] **Step 3: Implement**

Add to `protocol.ts`:

```ts
/** A room name is used verbatim as a folder segment, so it must be safe on its own. */
export const RoomName = z.string().min(1).max(64).regex(
  /^[a-z0-9][a-z0-9._-]*$/,
  "lowercase letters, digits, dot, dash and underscore only; must not start with a separator",
);

export const ScenePosition = z.object({ x: z.number(), z: z.number() });
export type ScenePosition = z.infer<typeof ScenePosition>;

export const RoomInfo = z.object({
  id: z.string(),
  /** Folder segment and display name. */
  name: RoomName,
  /** Absolute path of the room's folder. */
  path: z.string(),
  /** Where the building stands on the factory floor. */
  position: ScenePosition.default({ x: 0, z: 0 }),
  /** "project" is the single central building; "room" is a workshop. */
  kind: z.enum(["project", "room"]),
  agentCount: z.number().int().nonnegative(),
});
export type RoomInfo = z.infer<typeof RoomInfo>;
```

Extend `ClientMessage` with:
```ts
  z.object({ kind: z.literal("create_room"), name: RoomName }),
  z.object({ kind: z.literal("move_room"), roomId: z.string(), position: ScenePosition }),
  z.object({ kind: z.literal("list_rooms") }),
```
Extend `ServerMessage` with:
```ts
  z.object({ kind: z.literal("rooms"), rooms: z.array(RoomInfo) }),
```
Add `roomId: z.string().nullable()` to `SessionInfo`, and `roomId: z.string().optional()` to the existing `create_session` message (a session may belong to a room; M0 sessions have none).

Note: `RoomName`'s regex rejects `..` implicitly only because `.` cannot be the first character — `a..b` is still allowed and is a legal folder name, so path traversal is prevented by the leading-character rule plus the no-slash rule together. Do not relax either.

- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** — `feat(shared): rooms in the protocol`

---

### Task 2: Rooms table and folder creation

**Files:**
- Modify: `packages/server/src/db.ts` (migration step 3)
- Create: `packages/server/src/roomManager.ts`
- Test: `packages/server/test/roomManager.test.ts`, extend `packages/server/test/db.test.ts`

- [ ] **Step 1: Write failing tests**

`roomManager.test.ts` must cover:
1. `ensureProjectRoom()` creates exactly one `kind='project'` row for the project root, is idempotent across calls, and does not create a folder (the root already exists).
2. `createRoom("backend")` creates the folder `<root>/backend`, writes `<root>/backend/CLAUDE.md` containing the room name, inserts a row with `kind='room'`, and returns the `RoomInfo`.
3. `createRoom` on an existing name throws (and does not touch the existing folder's `CLAUDE.md` — assert the file content is unchanged).
4. `createRoom` refuses a name that escapes the root — pass `"..": ` the zod layer already rejects it, so here assert the manager itself also rejects a name whose resolved path is outside the root (defence in depth: call the manager directly with `"..%2f"`-style input or a name containing a separator and expect a throw).
5. `listRooms()` returns the project room first, then rooms ordered by creation, each with `agentCount` reflecting how many sessions reference it.
6. `moveRoom(id, {x,z})` persists the position and is reflected in `listRooms()`.
7. `moveRoom` on an unknown id throws.

Use `mkdtempSync` for the project root and remove it in a `finally`.

Extend `db.test.ts` with a migration test: a database at `user_version = 2` gains the `rooms` table and the `sessions.room_id` column, and existing session rows survive.

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement migration step 3** in `db.ts` (append — never edit step 1 or 2):

```sql
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'room',   -- project | room
  pos_x REAL NOT NULL DEFAULT 0,
  pos_z REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
ALTER TABLE sessions ADD COLUMN room_id TEXT;
```

- [ ] **Step 4: Implement `roomManager.ts`**

```ts
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import type { RoomInfo, ScenePosition } from "@superfabric/shared";

/** Charter template written into a new room's folder. Rooms are folders; this is the room's brief. */
function charter(name: string): string {
  return `# ${name}

## Responsibility

_What this department owns. Replace this line._

## Interfaces

_What other rooms can rely on from this one, and what it needs from them._

## Conventions

_Anything an agent working here must follow._
`;
}

export class RoomManager {
  constructor(private db: Db, private projectRoot: string) {}

  /** The single central building. Idempotent. */
  ensureProjectRoom(): RoomInfo { /* … */ }

  createRoom(name: string): RoomInfo { /* … */ }

  listRooms(): RoomInfo[] { /* … */ }

  moveRoom(roomId: string, position: ScenePosition): RoomInfo { /* … */ }
}
```

Implementation requirements:
- The project room's `name` is the project root's basename, `kind='project'`, `path` = the root, position `{x:0,z:0}`.
- `createRoom` resolves `path.resolve(projectRoot, name)` and **throws unless the result is inside `projectRoot`** (`resolved === root || resolved.startsWith(root + path.sep)`). This is the defence-in-depth check Task 2 step 1 item 4 tests.
- `createRoom` writes `CLAUDE.md` only when it does not already exist, so adopting an existing folder as a room never clobbers its docs.
- New rooms get an auto-assigned position on a ring around the origin so the first buildings don't stack: radius `8 + floor(n / 8) * 5`, angle `(n % 8) * (Math.PI / 4)` where `n` is the count of existing non-project rooms. Round to 3 decimals.
- `agentCount` comes from `SELECT COUNT(*) FROM sessions WHERE room_id = ?` — but keep `RoomManager` free of session logic beyond that one count; it must not import `SessionManager`.

- [ ] **Step 5: Run tests** — expect PASS. Root `pnpm build && pnpm test` green.
- [ ] **Step 6: Commit** — `feat(server): rooms as folders with a charter and floor positions`

---

### Task 3: Wire rooms into sessions, the hub and the entrypoint

**Files:**
- Modify: `packages/server/src/sessionManager.ts`, `packages/server/src/wsHub.ts`, `packages/server/src/index.ts`
- Test: extend `packages/server/test/sessionManager.test.ts`, `packages/server/test/wsHub.test.ts`

- [ ] **Step 1: Write failing tests**

- `SessionManager.createSession` accepts an optional `roomId`, persists it, and `listSessions()` reports it; omitting it yields `null`.
- A session created in a room uses that room's folder as its `cwd` (assert the recorded `ExecutorStartOptions.cwd`, using the recording executor pattern already in the suite).
- `WsHub`: `create_room` replies with a `rooms` message including the new room; `list_rooms` replies with the current rooms; `move_room` replies with the updated `rooms`; each of `create_room` with a duplicate name, `move_room` with an unknown id, and `create_session` with an unknown `roomId` replies `{kind:"error"}` and does **not** throw (the M0 dispatch guard must keep holding).
- `create_session` with a `roomId` also refreshes the `rooms` message so `agentCount` updates in one round trip.

- [ ] **Step 2: Run** — expect FAIL.

- [ ] **Step 3: Implement**

- `SessionManager` takes the `RoomManager` (constructor arg after the executor) so it can resolve a `roomId` to a `cwd`; `createSession(opts: { cwd?: string; roomId?: string; autonomy?: AutonomyMode })` — refactor the positional signature to an options object and update every call site and test. An unknown `roomId` throws.
- `WsHub` gains the three room cases, routed to `RoomManager`, each replying with a fresh `rooms` message. Keep everything inside the existing try/catch.
- `index.ts` constructs `RoomManager` with the project root (`process.env.SUPERFABRIC_PROJECT ?? process.cwd()`), calls `ensureProjectRoom()` on boot, and passes it to `SessionManager`. Log the project root at startup.

- [ ] **Step 4: Run tests** — expect PASS; root build + tests green.
- [ ] **Step 5: Commit** — `feat(server): sessions belong to rooms; room messages on the hub`

---

### Task 4: 3D scene scaffold

**Files:**
- Modify: `packages/web/package.json` (add `three`, `@react-three/fiber`, `@react-three/drei`, `@types/three`)
- Create: `packages/web/src/scene/Floor.tsx`, `packages/web/src/scene/FactoryScene.tsx`
- Modify: `packages/web/src/App.tsx`
- Test: `packages/web/test/scene.test.ts`

- [ ] **Step 1: Add dependencies**

`pnpm -F @superfabric/web add three @react-three/fiber @react-three/drei` and `pnpm -F @superfabric/web add -D @types/three`. All MIT — confirm with `pnpm -F @superfabric/web licenses list --prod` and report anything that isn't MIT/Apache/BSD/ISC.

- [ ] **Step 2: Implement the scene shell**

`FactoryScene.tsx` renders a `<Canvas>` with:
- An **orthographic** camera positioned isometrically: `position={[24, 20, 24]}`, `zoom={38}`, looking at the origin. Use drei's `<MapControls>` with `enableRotate={false}` so pan/zoom feel like a floor plan, and clamp zoom (`minZoom={12} maxZoom={90}`).
- Lighting: one `<ambientLight intensity={0.6}>` plus a `<directionalLight position={[10, 18, 6]} castShadow>`; enable `shadows` on the Canvas.
- `frameloop="demand"` plus drei's `<Stats>`-free setup — the scene must not burn GPU while idle. Because status changes and package animations need frames, expose a small helper that calls `invalidate()` when the store changes; the simplest correct approach is `frameloop="always"` **only while any animation is active** — implement a zustand selector `hasMotion` (true when any package is in flight or any agent is working) and switch `frameloop={hasMotion ? "always" : "demand"}`.
- `Floor.tsx`: a large `<mesh receiveShadow rotation-x={-Math.PI/2}>` with a `<planeGeometry args={[200,200]}>` and a muted material, plus drei `<Grid>` for a subtle factory-floor grid.

`App.tsx` becomes: `<FactoryScene />` full-viewport, with the existing M0 console markup moved verbatim into a new `packages/web/src/hud/ConsoleDrawer.tsx` rendered above the canvas (fixed position, right side, collapsible). Do not rewrite the console's behavior in this task — move it, keep it working.

- [ ] **Step 3: Test what is testable without a GPU**

jsdom cannot render WebGL, so do **not** try to mount `<Canvas>` in vitest. Instead extract the pure geometry/layout helpers into `packages/web/src/scene/layout.ts` and unit-test those:
- `ringPosition(index)` → the same ring formula the server uses, so client-side previews match server-assigned positions (export it and assert a few known values).
- `isoCameraTarget(rooms)` → the centroid the camera should look at, so the view frames all buildings; assert it averages positions and returns the origin for an empty list.
Write the tests first, then the helpers.

- [ ] **Step 4: Verify manually** — `pnpm -F @superfabric/web dev`, open the printed URL with the server running, confirm: a grid floor renders, pan and zoom work, rotation does not, and the console drawer still sends prompts. Report the observed behavior.
- [ ] **Step 5: Commit** — `feat(web): isometric 3D floor with the M0 console as an overlay drawer`

---

### Task 5: Buildings for the project and rooms

**Files:**
- Create: `packages/web/src/scene/Building.tsx`, `packages/web/src/scene/Buildings.tsx`
- Modify: `packages/web/src/store.ts`, `packages/web/src/wsClient.ts`, `packages/web/src/scene/FactoryScene.tsx`
- Test: extend `packages/web/test/store.test.ts`

- [ ] **Step 1: Store + client**

Add `rooms: RoomInfo[]` to the store, applied from the `rooms` server message. `wsClient.connect()` sends `list_rooms` alongside `list_sessions` on open. Add a selector `useRoom(id)` that returns one room, and `useRoomIds()` returning just the ids — so `Buildings` maps over ids and each `Building` subscribes to its own row. Test: a `rooms` message replaces the list; `useRoomIds` output is stable (same array contents ⇒ referentially equal) when an unrelated session event arrives, because that is what keeps buildings from re-rendering.

- [ ] **Step 2: Buildings**

`Building.tsx` — a memoized component taking `roomId`, reading its own row via the selector. Geometry (low-poly, procedural, no assets):
- `kind === "project"`: a larger block — `boxGeometry args={[6, 5, 6]}` at y = 2.5, plus a simple pitched roof (a 4-sided `coneGeometry` with `radialSegments={4}` rotated 45°) and a distinct material colour.
- `kind === "room"`: `boxGeometry args={[4, 3, 4]}` at y = 1.5 with a flatter roof.
- A drei `<Html>` label above each building showing the room name and, for rooms, `agentCount` — `distanceFactor` set so labels stay readable while zooming; `occlude` so labels behind buildings dim.
- Click selects the room (store field `selectedRoomId`); the selected building gets an outline (drei `<Outlines>` or an emissive material bump — either is fine, pick one and keep it consistent).
- `castShadow` on every mesh.

`Buildings.tsx` maps room ids to `<Building>`. Position each building from its room's `position` (`[x, 0, z]`).

- [ ] **Step 3: Manual verification** — with the server running, create two rooms from the console drawer (a temporary button is acceptable in this task if the room-creation UI is not built yet) and confirm two workshops appear on the ring around the central project building, labels show, clicking selects, shadows render.
- [ ] **Step 4: Commit** — `feat(web): project and room buildings on the factory floor`

---

### Task 6: Live status on the buildings

**Files:**
- Modify: `packages/web/src/store.ts`, `packages/web/src/scene/Building.tsx`
- Create: `packages/web/src/scene/StatusBeacon.tsx`
- Test: extend `packages/web/test/store.test.ts`

- [ ] **Step 1: Derive room status in the store (test first)**

Add a derived map `roomStatus: Record<roomId, "idle" | "working" | "blocked" | "error">`, computed from session events:
- `blocked` when any session in that room has an unresolved `approval_request`.
- `error` when the latest `session_status` for a session in the room is `error`.
- `working` when any session's latest `session_status` is `working` or `starting`.
- `idle` otherwise (including a room with no sessions).
Precedence: `error` > `blocked` > `working` > `idle`.

Test each precedence case explicitly with synthetic event sequences, including that a resolved approval clears `blocked` and that a room with no sessions is `idle`.

Sessions must be attributable to rooms: the store already receives `SessionInfo.roomId`, so build the mapping from that. A session with `roomId: null` contributes to no room.

- [ ] **Step 2: `StatusBeacon.tsx`** — a small emissive sphere above the roof whose colour maps status (`idle` dim grey, `working` amber, `blocked` orange, `error` red). When `working`, animate a gentle pulse with `useFrame` (scale between 0.9 and 1.15); when not working, render statically so `frameloop="demand"` can idle. Feed `hasMotion` from Task 4 with "any room working".

- [ ] **Step 3: Manual verification** — prompt an agent in a room from the console drawer, watch its building's beacon go amber while it works and settle when idle; trigger a gated tool (e.g. ask it to write a file) with autonomy `attended` so the beacon goes orange while an approval card is pending, then approve and watch it clear. Report what you observed. **One short prompt only** — this is the one place in this plan where a live agent turn is expected; keep it to a single trivial task.

- [ ] **Step 4: Commit** — `feat(web): per-room status beacons driven by session events`

---

### Task 7: Conveyors and packages

**Files:**
- Create: `packages/web/src/scene/Conveyor.tsx`, `packages/web/src/scene/Packages.tsx`, `packages/web/src/scene/conveyorPath.ts`
- Modify: `packages/web/src/store.ts`, `packages/web/src/scene/FactoryScene.tsx`
- Test: `packages/web/test/conveyorPath.test.ts`, extend `packages/web/test/store.test.ts`

The factory bus arrives in M3; this task builds the visual channel so that when the bus exists there is nothing left to do on the client but feed it. Until then, packages animate on a local `sendPackage(fromRoomId, toRoomId)` store action, which the M0 console drawer exposes as a manual "send a package" control for demonstration and which M3 will call from real bus messages.

- [ ] **Step 1: `conveyorPath.ts` (test first)**

Pure geometry, no React:
```ts
import { CatmullRomCurve3, Vector3 } from "three";
/** A belt from one building to another, bowed slightly outward so parallel belts don't overlap. */
export function conveyorCurve(from: ScenePosition, to: ScenePosition, bow = 0.18): CatmullRomCurve3
/** Point on the belt at t ∈ [0,1], lifted to belt height. */
export function pointAt(curve: CatmullRomCurve3, t: number): Vector3
```
Tests: the curve starts at `from` and ends at `to` (within a small epsilon, at belt height y); the midpoint of a bowed curve is **not** the straight-line midpoint; `bow = 0` gives a straight line; `pointAt(curve, 0)` equals the start.

- [ ] **Step 2: `Conveyor.tsx`** — renders one belt between two rooms: a flattened `tubeGeometry` along the curve (radius ~0.18, `radialSegments={4}`) in a dark material, plus evenly spaced thin "slat" boxes for texture. Memoize the geometry on the two positions so panning doesn't rebuild it.

Which belts exist: every room connects to the project building, and any pair of rooms that has ever exchanged a package. Derive the belt list in the store (`conveyors: {from, to}[]`) so the scene stays declarative.

- [ ] **Step 3: Packages (test the state, animate in the scene)**

Store: `packages: { id, from, to, startedAt, durationMs }[]`, plus `sendPackage(from, to)` which appends one, and a reaper that drops finished ones. Test: `sendPackage` adds a package between the right rooms; a package whose duration has elapsed is removed by the reaper; `hasMotion` is true while any package is in flight and false after the reaper runs.

`Packages.tsx`: one `instancedMesh` for all in-flight packages (a small box), positioned each frame via `useFrame` from `pointAt(curve, t)` where `t = clamp((now - startedAt) / durationMs)`. Use instancing from the start — a busy factory will have many packages and one draw call is the difference between smooth and not. Give the box a slight bob (`y += sin(t * π) * 0.15`) so it reads as travelling, not sliding.

- [ ] **Step 4: Manual verification** — with two rooms on the floor, use the console drawer's manual control to send a package and confirm a box travels the belt from one workshop to the other and disappears on arrival; confirm the scene returns to `demand` frameloop afterwards (no CPU spin when idle).
- [ ] **Step 5: Commit** — `feat(web): conveyor belts and animated package meshes`

---

### Task 8: Agent figures

**Files:**
- Create: `packages/web/src/scene/Agents.tsx`
- Modify: `packages/web/src/scene/Building.tsx` (or `Buildings.tsx` — place figures relative to their room)
- Test: extend `packages/web/test/store.test.ts`

- [ ] **Step 1: Store selector (test first)** — `useRoomAgents(roomId)` returning that room's sessions with their derived status (`working` / `idle` / `blocked` / `error`) and autonomy. Test: sessions are grouped by room; a session with `roomId: null` appears in no room; status derives per session (not per room) so two agents in one room can differ.

- [ ] **Step 2: `Agents.tsx`** — one low-poly figure per agent, standing in a small arc in front of its room's building: a `capsuleGeometry` body plus a `sphereGeometry` head, coloured by status using the same palette as the beacon. When the agent is `working`, animate a small bob and a slow shuffle along a short path in front of the building via `useFrame`; when idle, stand still. A `bypass`-autonomy agent gets a visually distinct marker (e.g. a thin ring at its feet) — the operator should be able to see at a glance which agents are ungated.

Keep the figures cheap: shared geometries/materials hoisted out of the component (module-level `useMemo`-free constants are fine for geometry created once), and no per-agent shadow casting if it costs frames — measure before enabling.

- [ ] **Step 3: Manual verification** — with two sessions in one room and one in another, confirm three figures appear in the right places, that the working one animates while the idle ones don't, and that a `bypass` agent is visibly marked. Reuse the already-running agents from Task 6's verification rather than prompting again.
- [ ] **Step 4: Commit** — `feat(web): agent figures with per-agent status and a bypass marker`

---

### Task 9: Room creation and selection in the overlay

**Files:**
- Create: `packages/web/src/hud/RoomPanel.tsx`
- Modify: `packages/web/src/hud/ConsoleDrawer.tsx`, `packages/web/src/App.tsx`
- Test: extend `packages/web/test/store.test.ts` if new store state is added

- [ ] **Step 1: Implement**

A left-side overlay panel:
- "New room" input + button (`create_room`), with the protocol's name rule explained inline and client-side validation matching `RoomName` so a bad name never round-trips.
- The room list; clicking one selects it (same `selectedRoomId` the buildings use, so scene and panel stay in sync).
- For the selected room: its path, its charter's first heading if available (skip if not trivially available — do not build a file-reading endpoint in this task), its agents with per-agent status and autonomy control, and a "New agent here" button that sends `create_session` with that `roomId`.
- Dragging a building on the floor sends `move_room` — implement with a pointer drag on the building mesh projected onto the floor plane, committing the position on pointer-up (one `move_room` per drag, not per frame).

- [ ] **Step 2: Manual verification** — create a room from the panel, watch a building appear; drag it, reload the page, confirm the position persisted; create an agent in the room and confirm a figure appears and the building's `agentCount` label updates.
- [ ] **Step 3: Commit** — `feat(web): room panel with creation, selection, drag-to-move and per-room agents`

---

### Task 10: M1a acceptance and docs

- [ ] **Step 1: Full verification run.** Fresh data dir, server + web up. Create two rooms; create one agent in each; give one agent a single short prompt; observe: buildings on the floor, labels with agent counts, beacons reacting to real work, figures animating for the working agent, a manual package travelling a belt, drag-to-move persisting across a reload, and the console drawer still able to interrupt and approve. Kill the server mid-session, restart, confirm the floor rebuilds from the server (rooms + sessions + statuses) and the agent still recalls its conversation. Report each observation.
- [ ] **Step 2: Update `docs/ROADMAP.md`** — mark the M1 items this plan delivered, and note what remains for M1 (roles library, onboarding agent, task panel).
- [ ] **Step 3: Update `CLAUDE.md`** — add the new modules to the layout section (`roomManager.ts`, `scene/`, `hud/`) and the invariant that scene state flows through per-object zustand selectors.
- [ ] **Step 4: Commit** — `docs: mark M1a complete (rooms and the 3D floor)`

---

## Self-review notes

- **Covers**: rooms as folders with charters (VISION "room = folder"), the 3D floor with project building + workshops + conveyors + packages + agent figures (the user's explicit visual requirement), live status from the event log, and layout persistence. 
- **Deliberately deferred**: the factory bus itself (M3 — Task 7 builds the visual channel and a manual trigger so M3 only has to call `sendPackage`), roles library and onboarding agent (rest of M1), task panel (M1/M3), containers (M4), glTF characters (M5 — Task 8 uses primitives).
- **Known risk**: `frameloop="demand"` plus `useFrame` animations interact subtly — if the beacon or packages ever appear frozen, the cause is almost certainly `hasMotion` not being true when it should be. Task 4 step 2 defines the contract; Tasks 6 and 7 must each keep it accurate.
- **Quota discipline**: exactly one live agent turn is expected in this whole plan (Task 6 step 3), reused by Task 8. Everything else is `FakeExecutor` or manual UI inspection.
