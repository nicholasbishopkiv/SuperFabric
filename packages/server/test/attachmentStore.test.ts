import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ATTACHMENTS_DIRNAME } from "@superfabric/shared";
import {
  AttachmentStore, attachmentFilename, extensionForMime, generatedName, sanitizeFilename,
} from "../src/attachmentStore.js";

/** A throwaway root to write into, cleaned up afterwards. */
function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "superfabric-attach-"));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("sanitizeFilename", () => {
  it("keeps an ordinary name unchanged", () => {
    expect(sanitizeFilename("report.pdf")).toBe("report.pdf");
    expect(sanitizeFilename("Screenshot 2026-08-04 at 11.02.33.png"))
      .toBe("Screenshot 2026-08-04 at 11.02.33.png");
  });

  it("strips separators of both conventions, so only the last segment survives", () => {
    expect(sanitizeFilename("a/b/c.txt")).toBe("c.txt");
    // a Windows browser can send backslashes, and POSIX basename() would hand this back whole
    expect(sanitizeFilename("..\\..\\.ssh\\authorized_keys")).toBe("authorized_keys");
    expect(sanitizeFilename("dir/sub/")).toBe(null);
  });

  it("refuses traversal and absolute paths", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..")).toBe(null);
    expect(sanitizeFilename("../")).toBe(null);
    expect(sanitizeFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("/")).toBe(null);
    expect(sanitizeFilename("C:\\Windows\\System32\\drivers\\etc\\hosts")).toBe("hosts");
  });

  it("returns null for nothing usable: empty, whitespace, only dots", () => {
    expect(sanitizeFilename("")).toBe(null);
    expect(sanitizeFilename("   ")).toBe(null);
    expect(sanitizeFilename(".")).toBe(null);
    expect(sanitizeFilename("..")).toBe(null);
    expect(sanitizeFilename("....")).toBe(null);
    expect(sanitizeFilename(". . .")).toBe(null);
    expect(sanitizeFilename(undefined)).toBe(null);
    expect(sanitizeFilename(null)).toBe(null);
  });

  it("never produces a dotfile — a leading dot is stripped", () => {
    expect(sanitizeFilename(".bashrc")).toBe("bashrc");
    expect(sanitizeFilename("..hidden.png")).toBe("hidden.png");
  });

  it("drops control characters and trailing dots or spaces", () => {
    expect(sanitizeFilename("evil\u0000.png")).toBe("evil.png");
    expect(sanitizeFilename("note\n\t.txt")).toBe("note.txt");
    // Windows strips these silently, which is how "evil.exe." becomes "evil.exe" downstream
    expect(sanitizeFilename("evil.exe.")).toBe("evil.exe");
    expect(sanitizeFilename("spaced.png   ")).toBe("spaced.png");
  });

  it("keeps unicode: these are ordinary filenames, not something to mangle", () => {
    expect(sanitizeFilename("отчёт.pdf")).toBe("отчёт.pdf");
    expect(sanitizeFilename("スクリーンショット.png")).toBe("スクリーンショット.png");
    expect(sanitizeFilename("naïve—dash.txt")).toBe("naïve—dash.txt");
    // …and still only the last segment of a unicode path
    expect(sanitizeFilename("папка/отчёт.pdf")).toBe("отчёт.pdf");
  });

  it("bounds the length while keeping the extension", () => {
    const long = `${"a".repeat(400)}.png`;
    const out = sanitizeFilename(long)!;
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(".png")).toBe(true);
  });
});

describe("extensionForMime", () => {
  it("maps the clipboard image types a paste actually produces", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("image/gif")).toBe(".gif");
    expect(extensionForMime("image/webp")).toBe(".webp");
    expect(extensionForMime("image/svg+xml")).toBe(".svg");
  });

  it("tolerates parameters and case, as a browser sends them", () => {
    expect(extensionForMime("IMAGE/PNG")).toBe(".png");
    expect(extensionForMime("text/plain;charset=utf-8")).toBe(".txt");
  });

  it("admits it does not know rather than inventing an extension", () => {
    expect(extensionForMime("application/x-made-up")).toBe(".bin");
    expect(extensionForMime("")).toBe(".bin");
    expect(extensionForMime(undefined)).toBe(".bin");
  });
});

describe("attachmentFilename", () => {
  const now = new Date("2026-08-04T11:02:33.125Z");

  it("generates a timestamped name with a real extension for a nameless clipboard image", () => {
    expect(generatedName("image/png", now)).toBe("pasted-2026-08-04T11-02-33-125Z.png");
    expect(attachmentFilename(undefined, "image/png", now)).toBe("pasted-2026-08-04T11-02-33-125Z.png");
    expect(attachmentFilename("", "image/jpeg", now)).toBe("pasted-2026-08-04T11-02-33-125Z.jpg");
    // a name that sanitises to nothing is the same case
    expect(attachmentFilename("..", "image/gif", now)).toBe("pasted-2026-08-04T11-02-33-125Z.gif");
    // and so is "blob", which is what a browser calls a payload it was handed with no name
    expect(attachmentFilename("blob", "image/webp", now)).toBe("pasted-2026-08-04T11-02-33-125Z.webp");
  });

  it("appends the type's extension when the name has none", () => {
    expect(attachmentFilename("image", "image/png", now)).toBe("image.png");
  });

  it("leaves a usable name alone", () => {
    expect(attachmentFilename("diagram.svg", "image/svg+xml", now)).toBe("diagram.svg");
  });
});

describe("AttachmentStore.save", () => {
  it("writes the file into <root>/attachments with the right bytes", () => {
    withRoot((root) => {
      const saved = new AttachmentStore().save(root, { filename: "hello.txt", mime: "text/plain", bytes: bytes("hi there") });
      expect(saved.path).toBe(join(root, ATTACHMENTS_DIRNAME, "hello.txt"));
      expect(saved.name).toBe("hello.txt");
      expect(saved.bytes).toBe(8);
      expect(readFileSync(saved.path, "utf8")).toBe("hi there");
    });
  });

  it("writes binary bytes through unchanged", () => {
    withRoot((root) => {
      const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
      const saved = new AttachmentStore().save(root, { filename: "shot.png", mime: "image/png", bytes: payload });
      expect(new Uint8Array(readFileSync(saved.path))).toEqual(payload);
    });
  });

  it("uniquifies instead of overwriting the operator's file", () => {
    withRoot((root) => {
      const store = new AttachmentStore();
      const first = store.save(root, { filename: "shot.png", mime: "image/png", bytes: bytes("one") });
      const second = store.save(root, { filename: "shot.png", mime: "image/png", bytes: bytes("two") });
      const third = store.save(root, { filename: "shot.png", mime: "image/png", bytes: bytes("three") });
      expect([first.name, second.name, third.name]).toEqual(["shot.png", "shot-2.png", "shot-3.png"]);
      // the first file is untouched — that is the whole point
      expect(readFileSync(first.path, "utf8")).toBe("one");
      expect(readFileSync(second.path, "utf8")).toBe("two");
      expect(readFileSync(third.path, "utf8")).toBe("three");
    });
  });

  it("uniquifies around a file it did not write", () => {
    withRoot((root) => {
      mkdirSync(join(root, ATTACHMENTS_DIRNAME), { recursive: true });
      writeFileSync(join(root, ATTACHMENTS_DIRNAME, "notes"), "theirs");
      const saved = new AttachmentStore().save(root, { filename: "notes", mime: "text/plain", bytes: bytes("ours") });
      // "notes" has no extension, so the type supplies one; the operator's file is still theirs
      expect(saved.name).toBe("notes.txt");
      expect(readFileSync(join(root, ATTACHMENTS_DIRNAME, "notes"), "utf8")).toBe("theirs");
    });
  });

  it("stays inside the destination root, whatever the browser called the file", () => {
    withRoot((root) => {
      const store = new AttachmentStore();
      for (const filename of ["../escape.txt", "../../escape.txt", "/etc/passwd", "..\\..\\escape.txt"]) {
        const saved = store.save(root, { filename, mime: "text/plain", bytes: bytes("x") });
        expect(saved.path.startsWith(join(root, ATTACHMENTS_DIRNAME) + sep)).toBe(true);
      }
      expect(existsSync(join(root, "escape.txt"))).toBe(false);
      expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
    });
  });

  it("validates against the root it is given — a room folder outside the project counts", () => {
    withRoot((projectRoot) => {
      withRoot((roomRoot) => {
        const store = new AttachmentStore();
        // The room folder is a sibling of the project root, not under it: containment is against
        // *this* root, because a room may live in another repository entirely.
        expect(roomRoot.startsWith(projectRoot + sep)).toBe(false);
        const saved = store.save(roomRoot, { filename: "../../loot.txt", mime: "text/plain", bytes: bytes("x") });
        expect(saved.path).toBe(join(roomRoot, ATTACHMENTS_DIRNAME, "loot.txt"));
        expect(existsSync(join(projectRoot, ATTACHMENTS_DIRNAME))).toBe(false);
      });
    });
  });

  it("enforces the size cap", () => {
    withRoot((root) => {
      const store = new AttachmentStore(10);
      expect(() => store.save(root, { filename: "big.bin", bytes: new Uint8Array(11) }))
        .toThrow(/over the 10-byte attachment limit/);
      // exactly at the cap is fine
      expect(store.save(root, { filename: "ok.bin", bytes: new Uint8Array(10) }).bytes).toBe(10);
      expect(existsSync(join(root, ATTACHMENTS_DIRNAME, "big.bin"))).toBe(false);
    });
  });

  it("refuses an empty payload and a relative root", () => {
    withRoot((root) => {
      const store = new AttachmentStore();
      expect(() => store.save(root, { filename: "empty.txt", bytes: new Uint8Array(0) })).toThrow(/empty/);
      expect(() => store.save("relative/dir", { filename: "a.txt", bytes: bytes("x") })).toThrow(/absolute/);
    });
  });
});
