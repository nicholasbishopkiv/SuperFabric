import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { ProjectManager } from "../src/projectManager.js";

/** A throwaway boot root plus a manager over an in-memory db, cleaned up afterwards. */
function withManager<T>(fn: (ctx: {
  root: string;
  db: ReturnType<typeof openDb>;
  projects: ProjectManager;
  /** A monotonic clock the tests drive, so "last opened" is a fact rather than a race. */
  tick: () => number;
}) => T): T {
  const root = mkdtempSync(join(tmpdir(), "superfabric-project-"));
  const db = openDb(":memory:");
  let clock = 1_000;
  try {
    return fn({ root, db, projects: new ProjectManager(db, root, () => clock), tick: () => (clock += 10) });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** Another existing directory, for the second factory. */
function tempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `superfabric-project-${label}-`));
}

describe("ProjectManager", () => {
  describe("create", () => {
    it("stores an absolute root and names it after the folder", () => {
      withManager(({ projects }) => {
        const other = tempRoot("other");
        try {
          const project = projects.create({ root: other });
          expect(project).toMatchObject({ root: other, name: basename(other), lastOpenedAt: null });
          expect(projects.get(project.id)).toEqual(project);
        } finally {
          rmSync(other, { recursive: true, force: true });
        }
      });
    });

    it("takes an explicit name over the folder's, and trims it", () => {
      withManager(({ projects }) => {
        const other = tempRoot("named");
        try {
          expect(projects.create({ root: other, name: "  The Shop  " }).name).toBe("The Shop");
          // a name that is only whitespace is not a name; fall back to the folder
          const another = tempRoot("blank");
          try {
            expect(projects.create({ root: another, name: "   " }).name).toBe(basename(another));
          } finally {
            rmSync(another, { recursive: true, force: true });
          }
        } finally {
          rmSync(other, { recursive: true, force: true });
        }
      });
    });

    it("refuses a relative path, a missing folder, a file, and a duplicate root", () => {
      withManager(({ db, projects, root }) => {
        // A relative root would resolve against whatever directory the server was started in, which
        // is exactly the ambiguity a project root must not have.
        expect(() => projects.create({ root: "code/shop" })).toThrow(/absolute path/);
        expect(() => projects.create({ root: join(root, "not-there") })).toThrow(/does not exist/);

        const file = join(root, "a-file");
        writeFileSync(file, "not a folder\n");
        expect(() => projects.create({ root: file })).toThrow(/not a directory/);

        // The manager never creates a directory: a mistyped path is an error, not a new folder.
        expect((db.prepare("SELECT COUNT(*) c FROM projects").get() as { c: number }).c).toBe(0);

        const first = projects.create({ root });
        expect(() => projects.create({ root })).toThrow(/already exists/);
        expect(projects.list().map((p) => p.id)).toEqual([first.id]);
      });
    });
  });

  describe("defaultProject", () => {
    it("is the boot root's project, created once", () => {
      withManager(({ root, projects }) => {
        const first = projects.defaultProject();
        expect(first.root).toBe(root);
        expect(projects.defaultProject().id).toBe(first.id);
        expect(projects.list()).toHaveLength(1);
      });
    });

    it("adopts a project that already exists for the boot root", () => {
      withManager(({ root, db, projects }) => {
        const created = projects.create({ root, name: "Hand-made" });
        // a restart must not add a second project for the same folder
        expect(new ProjectManager(db, root).defaultProject().id).toBe(created.id);
        expect(projects.list()).toHaveLength(1);
      });
    });
  });

  describe("open", () => {
    it("stamps last_opened_at and throws for an unknown id", () => {
      withManager(({ projects, tick }) => {
        const project = projects.defaultProject();
        expect(project.lastOpenedAt).toBeNull();
        const at = tick();
        expect(projects.open(project.id).lastOpenedAt).toBe(at);
        expect(projects.get(project.id)!.lastOpenedAt).toBe(at);
        expect(() => projects.open("nope")).toThrow(/unknown project/);
      });
    });
  });

  describe("lastOpened", () => {
    it("is what a fresh tab lands on: the factory the operator was last in", () => {
      withManager(({ projects, tick }) => {
        const other = tempRoot("last");
        try {
          const boot = projects.defaultProject();
          const second = projects.create({ root: other });
          // nobody has opened anything yet: fall back to the boot project
          expect(projects.lastOpened().id).toBe(boot.id);

          tick();
          projects.open(second.id);
          expect(projects.lastOpened().id).toBe(second.id);

          tick();
          projects.open(boot.id);
          expect(projects.lastOpened().id).toBe(boot.id);
        } finally {
          rmSync(other, { recursive: true, force: true });
        }
      });
    });
  });

  describe("list", () => {
    it("keeps creation order, so the switcher does not reshuffle as it is used", () => {
      withManager(({ projects, tick }) => {
        const a = tempRoot("a");
        const b = tempRoot("b");
        try {
          const boot = projects.defaultProject();
          const first = projects.create({ root: a });
          const second = projects.create({ root: b });
          tick();
          projects.open(second.id);
          expect(projects.list().map((p) => p.id)).toEqual([boot.id, first.id, second.id]);
        } finally {
          rmSync(a, { recursive: true, force: true });
          rmSync(b, { recursive: true, force: true });
        }
      });
    });
  });

  describe("get / require / root", () => {
    it("speaks undefined for an unknown id, and throws only where a caller must have one", () => {
      withManager(({ root, projects }) => {
        const project = projects.defaultProject();
        expect(projects.get("nope")).toBeUndefined();
        expect(projects.require(project.id).id).toBe(project.id);
        expect(() => projects.require("nope")).toThrow(/unknown project/);
        expect(projects.root(project.id)).toBe(root);
      });
    });
  });
});
