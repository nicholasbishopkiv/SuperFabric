import { describe, it, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgentClis } from "../src/toolchain.js";

/**
 * What is on the machine, reported without running any of it.
 *
 * Two properties are the point. **Nothing is executed** — detection is a `PATH` walk and a `stat`,
 * so opening a popover never spawns a subprocess on someone's machine. And **"cannot tell" is a
 * distinct answer from "not signed in"**: a CLI whose credentials live in a keyring must not be
 * reported as logged out, because an operator who *is* logged in would then be shown a false claim
 * about their own machine.
 */

interface Fake {
  home: string;
  bin: string;
  cleanup(): void;
}

function fakeMachine(): Fake {
  const root = mkdtempSync(join(tmpdir(), "sf-toolchain-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { home, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** An executable with the right name and nothing inside it — never run, only found. */
function install(m: Fake, command: string): void {
  const file = join(m.bin, command);
  writeFileSync(file, "#!/bin/sh\nexit 9\n");
  chmodSync(file, 0o755);
}

function signIn(m: Fake, relative: string): void {
  const file = join(m.home, relative);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "{}");
}

const detect = (m: Fake) => detectAgentClis({ home: m.home, searchPath: [m.bin] });

describe("detecting the agent CLIs on this machine", () => {
  it("reports every one it looks for, installed or not", () => {
    const m = fakeMachine();
    try {
      install(m, "codex");
      const tools = detect(m);
      const byId = Object.fromEntries(tools.map((t) => [t.id, t]));

      // "We looked for claude and it is not here" is a more useful answer than a list that only
      // contains what happened to be found.
      expect(Object.keys(byId)).toContain("claude");
      expect(byId.claude!.path).toBeNull();
      expect(byId.codex!.path).toBe(join(m.bin, "codex"));
    } finally {
      m.cleanup();
    }
  });

  it("says which one SuperFabric can actually staff a room with", () => {
    const m = fakeMachine();
    try {
      install(m, "claude");
      install(m, "codex");
      const tools = detect(m);

      // The whole reason this surface is safe to show: exactly one entry claims it runs agents.
      expect(tools.filter((t) => t.runsAgents).map((t) => t.id)).toEqual(["claude"]);
      expect(tools.find((t) => t.id === "codex")!.detail).toMatch(/cannot staff a room/i);
    } finally {
      m.cleanup();
    }
  });

  it("reads a sign-in off disk where there is a file that settles it", () => {
    const m = fakeMachine();
    try {
      install(m, "claude");
      install(m, "codex");
      signIn(m, ".claude/.credentials.json");

      const tools = detect(m);
      expect(tools.find((t) => t.id === "claude")!.signedIn).toBe(true);
      // Installed, no credentials file: this one really is signed out.
      expect(tools.find((t) => t.id === "codex")!.signedIn).toBe(false);
    } finally {
      m.cleanup();
    }
  });

  it("answers 'cannot tell' rather than 'signed out' when the login is not a file", () => {
    const m = fakeMachine();
    try {
      install(m, "agy");
      const agy = detect(m).find((t) => t.id === "antigravity")!;
      expect(agy.path).toBe(join(m.bin, "agy"));
      // Null, not false. Showing a logged-in operator as logged out is a false claim about their own
      // machine, and the one failure mode this surface could plausibly have.
      expect(agy.signedIn).toBeNull();
    } finally {
      m.cleanup();
    }
  });

  it("does not mistake a non-executable file for an installed CLI", () => {
    const m = fakeMachine();
    try {
      writeFileSync(join(m.bin, "codex"), "not a program");
      chmodSync(join(m.bin, "codex"), 0o644);
      expect(detect(m).find((t) => t.id === "codex")!.path).toBeNull();
    } finally {
      m.cleanup();
    }
  });

  it("is stable and side-effect free: the same machine answers the same twice", () => {
    const m = fakeMachine();
    try {
      install(m, "claude");
      expect(detect(m)).toEqual(detect(m));
    } finally {
      m.cleanup();
    }
  });
});
