import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoleLibrary } from "../src/roleLibrary.js";

/**
 * The role loader: a role is a file, and these are the properties that makes safe.
 *
 * The two that matter most are both about *silence*. A malformed preset must be reported rather than
 * skipped — a picker that is quietly one entry shorter than the operator's folder gives them nothing
 * to act on — and an unknown field must be an error rather than an ignored key, because `skill:`
 * where `skills:` was meant would otherwise ship a role whose whole point never arrives.
 */

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "sf-roles-"));
  const shippedDir = join(root, "shipped");
  const userDir = join(root, "user");
  mkdirSync(shippedDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  return {
    root, shippedDir, userDir,
    lib: () => new RoleLibrary({ shippedDir, userDir }),
    write: (dir: string, name: string, text: string) => {
      const file = join(dir, name);
      writeFileSync(file, text);
      return file;
    },
    cleanup: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

const MINIMAL = `
id: backend
name: Backend
summary: Server-side code.
promptAppend: You are the backend engineer.
`;

describe("role library", () => {
  it("loads a minimal role, and everything optional defaults to 'no opinion'", () => {
    const d = dirs();
    try {
      d.write(d.shippedDir, "backend.yaml", MINIMAL);
      const role = d.lib().get("backend");
      expect(role).toBeDefined();
      expect(role!.name).toBe("Backend");
      expect(role!.summary).toBe("Server-side code.");
      expect(role!.promptAppend).toBe("You are the backend engineer.");
      // Absent is not a value: a role with no model can never be the reason an agent is on one.
      expect(role!.model).toBeUndefined();
      expect(role!.autonomy).toBeUndefined();
      expect(role!.skills).toEqual([]);
      expect(role!.mcpServers).toEqual({});
      expect(role!.allowedTools).toEqual([]);
      expect(d.lib().problems()).toEqual([]);
    } finally { d.cleanup(); }
  });

  it("lists every role by id, and `.yml` counts as much as `.yaml`", () => {
    const d = dirs();
    try {
      d.write(d.shippedDir, "backend.yaml", MINIMAL);
      d.write(d.shippedDir, "architect.yml", `
id: architect
name: Architect
summary: Shape, not code.
promptAppend: You are the architect.
`);
      expect(d.lib().list().map((r) => r.id)).toEqual(["architect", "backend"]);
    } finally { d.cleanup(); }
  });

  it("a user file overrides a shipped one by id, and adds one that is only theirs", () => {
    const d = dirs();
    try {
      d.write(d.shippedDir, "backend.yaml", MINIMAL);
      // A different *filename*, the same id: the override is by id, which is what lets an operator
      // keep their own naming and still replace what we ship.
      d.write(d.userDir, "my-backend.yaml", `
id: backend
name: Backend (ours)
summary: Server-side code, our way.
model: claude-haiku-4-5
promptAppend: You are our backend engineer.
`);
      d.write(d.userDir, "dba.yaml", `
id: dba
name: DBA
summary: Databases.
promptAppend: You are the DBA.
`);
      const lib = d.lib();
      expect(lib.list().map((r) => r.id)).toEqual(["backend", "dba"]);
      const backend = lib.get("backend")!;
      expect(backend.name).toBe("Backend (ours)");
      expect(backend.model).toBe("claude-haiku-4-5");
      expect(lib.fileOf("backend")).toBe(join(d.userDir, "my-backend.yaml"));
      expect(lib.problems()).toEqual([]);
    } finally { d.cleanup(); }
  });

  it("a malformed file is reported by name, and the roles around it still load", () => {
    const d = dirs();
    try {
      d.write(d.shippedDir, "backend.yaml", MINIMAL);
      const bad = d.write(d.shippedDir, "broken.yaml", "id: broken\nname: [unclosed\n");
      const lib = d.lib();
      // Reported, not skipped: the operator has to be able to find out their preset is broken.
      expect(lib.problems()).toHaveLength(1);
      expect(lib.problems()[0]!.file).toBe(bad);
      expect(lib.problems()[0]!.message).toMatch(/not valid YAML/);
      // And the failure is contained: one bad file does not take the library with it.
      expect(lib.list().map((r) => r.id)).toEqual(["backend"]);
    } finally { d.cleanup(); }
  });

  it("an unknown field is an error, not an ignored key", () => {
    const d = dirs();
    try {
      // The exact failure a hand-written config format has to design against: a typo that parses.
      const file = d.write(d.shippedDir, "typo.yaml", `
id: backend
name: Backend
summary: Server-side code.
promptAppend: You are the backend engineer.
skill:
  - test-driven-development
`);
      const lib = d.lib();
      expect(lib.get("backend")).toBeUndefined();
      expect(lib.problems()).toHaveLength(1);
      expect(lib.problems()[0]!.file).toBe(file);
      expect(lib.problems()[0]!.message).toMatch(/skill/);
    } finally { d.cleanup(); }
  });

  it("reports a role whose fields are the wrong shape, naming the field", () => {
    const d = dirs();
    try {
      d.write(d.shippedDir, "bad.yaml", `
id: Backend Room
name: Backend
summary: Server-side code.
promptAppend: You are the backend engineer.
`);
      const problems = d.lib().problems();
      expect(problems).toHaveLength(1);
      expect(problems[0]!.message).toMatch(/^is not a role: id:/);
    } finally { d.cleanup(); }
  });

  it("reports an empty file and a multi-document file rather than crashing on either", () => {
    const d = dirs();
    try {
      d.write(d.shippedDir, "empty.yaml", "\n# nothing but a comment\n");
      d.write(d.shippedDir, "two.yaml", `${MINIMAL}---\n${MINIMAL}`);
      const messages = d.lib().problems().map((p) => p.message);
      expect(messages).toEqual(["is empty", "holds several YAML documents; a role file is one role"]);
    } finally { d.cleanup(); }
  });

  it("two files in one directory claiming the same id are a reported clash, not a coin toss", () => {
    const d = dirs();
    try {
      const first = d.write(d.shippedDir, "a-backend.yaml", MINIMAL);
      d.write(d.shippedDir, "b-backend.yaml", MINIMAL);
      const lib = d.lib();
      // Nothing silently wins: readdir order must not decide which charter an agent gets.
      expect(lib.problems()).toHaveLength(1);
      expect(lib.problems()[0]!.file).toBe(join(d.shippedDir, "b-backend.yaml"));
      expect(lib.problems()[0]!.message).toContain(first);
      expect(lib.get("backend")!.name).toBe("Backend");
    } finally { d.cleanup(); }
  });

  it("picks up an edited file without a restart, and a new one, and a deleted one", () => {
    const d = dirs();
    try {
      const file = d.write(d.shippedDir, "backend.yaml", MINIMAL);
      // One library, alive across every change below: an operator tuning a preset must not have to
      // bounce the server to see it.
      const lib = d.lib();
      expect(lib.get("backend")!.name).toBe("Backend");

      writeFileSync(file, MINIMAL.replace("name: Backend", "name: Backend II"));
      expect(lib.get("backend")!.name).toBe("Backend II");

      d.write(d.userDir, "dba.yaml", "id: dba\nname: DBA\nsummary: Databases.\npromptAppend: You are the DBA.\n");
      expect(lib.list().map((r) => r.id)).toEqual(["backend", "dba"]);

      rmSync(file);
      expect(lib.get("backend")).toBeUndefined();
      expect(lib.list().map((r) => r.id)).toEqual(["dba"]);
    } finally { d.cleanup(); }
  });

  it("notices an edit that keeps the file the same size, because mtime is part of the signature", () => {
    const d = dirs();
    try {
      const file = d.write(d.shippedDir, "backend.yaml", MINIMAL);
      const lib = d.lib();
      expect(lib.get("backend")!.summary).toBe("Server-side code.");
      // Same byte count, different content — the case a size-only check would miss.
      const edited = MINIMAL.replace("Server-side code.", "Server-side CODE.");
      expect(edited.length).toBe(MINIMAL.length);
      writeFileSync(file, edited);
      const later = new Date(Date.now() + 2_000);
      utimesSync(file, later, later);
      expect(lib.get("backend")!.summary).toBe("Server-side CODE.");
    } finally { d.cleanup(); }
  });

  it("reload() re-reads even when nothing on disk looks different", () => {
    const d = dirs();
    try {
      d.write(d.shippedDir, "backend.yaml", MINIMAL);
      const lib = d.lib();
      expect(lib.list()).toHaveLength(1);
      lib.reload();
      expect(lib.list()).toHaveLength(1);
    } finally { d.cleanup(); }
  });

  it("a missing directory is an empty library, not a crash: a server with no user roles is normal", () => {
    const d = dirs();
    try {
      const lib = new RoleLibrary({ shippedDir: join(d.root, "not-there") });
      expect(lib.list()).toEqual([]);
      expect(lib.problems()).toEqual([]);
    } finally { d.cleanup(); }
  });

  it("ignores files that are not YAML, so a README beside the presets is not an error", () => {
    const d = dirs();
    try {
      d.write(d.shippedDir, "backend.yaml", MINIMAL);
      d.write(d.shippedDir, "README.md", "# how to write a role\n");
      const lib = d.lib();
      expect(lib.list()).toHaveLength(1);
      expect(lib.problems()).toEqual([]);
    } finally { d.cleanup(); }
  });

  it("takes an operator's MCP server and pre-approved tools verbatim, and refuses an unknown transport", () => {
    const d = dirs();
    try {
      d.write(d.shippedDir, "browser.yaml", `
id: browser
name: Browser
summary: Drives a real browser.
promptAppend: You drive the browser.
mcpServers:
  playwright:
    type: stdio
    command: npx
    args: ["-y", "@playwright/mcp@latest"]
allowedTools:
  - mcp__playwright__browser_navigate
`);
      d.write(d.shippedDir, "bogus.yaml", `
id: bogus
name: Bogus
summary: An MCP transport nobody has.
promptAppend: Nope.
mcpServers:
  weird:
    type: carrier-pigeon
    command: coo
`);
      const lib = d.lib();
      const role = lib.get("browser")!;
      expect(role.mcpServers.playwright).toEqual({
        type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"], env: {},
      });
      expect(role.allowedTools).toEqual(["mcp__playwright__browser_navigate"]);
      expect(lib.get("bogus")).toBeUndefined();
      expect(lib.problems().map((p) => p.message).join()).toMatch(/mcpServers\.weird/);
    } finally { d.cleanup(); }
  });
});
