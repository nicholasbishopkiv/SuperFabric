import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/eventStore.js";
import { ClaudeCodeExecutor, type QueryFn } from "../src/executors/claudeCode.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoleLibrary } from "../src/roleLibrary.js";
import { RoomManager } from "../src/roomManager.js";
import { SessionManager } from "../src/sessionManager.js";
import { ROOM_SKILLS_DIR, SkillLibrary } from "../src/skills.js";

/**
 * M1c's acceptance: **a shipped role, on a real agent, proved from what the SDK was actually given.**
 *
 * `roleApply.test.ts` already proves the mechanism against synthetic role files; this proves the
 * product's own. One case, not a re-run: an architect created from `roles/architect.yaml` arrives
 * with that file's charter, that file's model, and that file's skills on disk beside it.
 *
 * The interview itself was accepted live (one run, an imaginary household expense tracker) — see
 * `docs/ROADMAP.md` for the transcript and the judgement. Nothing here prompts a real agent.
 */

/** Records the `Options` of every `query()`, and otherwise says nothing. */
function recordingQuery() {
  const calls: Options[] = [];
  const fn: QueryFn = (params) => {
    calls.push(params.options ?? {});
    if (typeof params.prompt !== "string") {
      void (async () => { for await (const _ of params.prompt) { /* discard */ } })();
    }
    let end!: () => void;
    const closed = new Promise<void>((resolve) => { end = resolve; });
    const gen = (async function* (): AsyncGenerator<SDKMessage, void> { await closed; })();
    return {
      next: () => gen.next(),
      return: (v: void | PromiseLike<void>) => gen.return(v),
      throw: (e: unknown) => gen.throw(e),
      [Symbol.asyncIterator]() { return this; },
      interrupt: async () => undefined,
      close: () => { end(); },
    } as unknown as Query;
  };
  return { calls, fn };
}

describe("M1c acceptance", () => {
  it("a shipped role's prompt, model and skills reach the real query()", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-m1c-acceptance-"));
    try {
      const db = openDb(":memory:");
      const { calls, fn } = recordingQuery();
      const projects = new ProjectManager(db, root);
      const rooms = new RoomManager(db, projects);
      // The product's own files, and the machine's own skill directories: nothing synthetic.
      const roles = new RoleLibrary();
      const skills = new SkillLibrary();
      const mgr = new SessionManager(
        db, new EventStore(db), new ClaudeCodeExecutor({ query: fn }), rooms, projects,
        { roles, skills },
      );
      mkdirSync(join(root, "design"), { recursive: true });
      const room = rooms.createRoom("design");

      mgr.createSession({ roomId: room.id, roleId: "architect" });
      const opts = calls[0]!;
      const architect = roles.get("architect")!;

      // The charter, verbatim, in the preset-object form the SDK takes.
      const prompt = opts.systemPrompt;
      const append = prompt === undefined || typeof prompt === "string" || Array.isArray(prompt)
        ? undefined
        : prompt.append;
      expect(append).toBe(architect.promptAppend);
      // The model the file asks for — the operator pinned none, so the preset speaks.
      expect(opts.model).toBe("claude-opus-5");
      // And the skills. A machine without the `superpowers` pack resolves nothing, so the assertion
      // is on the mechanism rather than on this machine's installation: what resolves is copied into
      // the room, and what does not is absent rather than half-written.
      for (const name of architect.skills) {
        expect(existsSync(join(room.path, ROOM_SKILLS_DIR, name, "SKILL.md"))).toBe(skills.has(name));
      }
      expect(architect.skills.length).toBeGreaterThan(0);

      await mgr.stopAll();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
