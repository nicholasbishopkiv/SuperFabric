import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ATTACHMENTS_DIRNAME, MAX_ATTACHMENT_BYTES, type SavedAttachment } from "@superfabric/shared";

/**
 * Files in, paths out.
 *
 * The operator pastes, drops or uploads a file in the browser; it is written into the active
 * project's folder — or the selected room's, which **may be outside the project root** since M1b —
 * and the *path* is what the agent is eventually handed. Nothing here ever touches the event log:
 * an attachment is a file on disk plus a line of turn text, which is what an agent with file tools
 * actually wants and what keeps the log small.
 *
 * Two things this module is careful about, because the bytes and the name both come from a browser:
 *
 * - **The name is untrusted.** It is folded to a single safe path segment (`sanitizeFilename`) and
 *   the *resolved* destination is then re-checked against the destination root, the same two-layer
 *   check `RoomManager.createRoom` does. One layer would be enough on a good day; this is a local
 *   privileged tool and there are no good days.
 * - **Nothing is ever overwritten.** A name that is taken is uniquified (`shot-2.png`), and the
 *   write itself uses `wx` so two uploads racing for the same name cannot clobber each other —
 *   the loser retries with the next suffix rather than winning by being second.
 */

/** How many `-2`, `-3`… variants to try before giving up on a name. */
const MAX_UNIQUIFY_TRIES = 500;

/** Longest final filename we will write, extension included. Long enough for anything sane. */
const MAX_NAME_LENGTH = 120;

/**
 * MIME type -> file extension, for payloads that arrive with no usable name.
 *
 * **A clipboard image has no filename at all** — the browser hands over `image/png` and a blob — so
 * the extension has to come from the type rather than from a guess. Kept deliberately short: these
 * are the types a paste or a drop actually produces. Anything unknown gets `.bin`, which is honest;
 * inventing an extension for an unrecognised type would be worse than admitting we do not know.
 */
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/heic": ".heic",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/html": ".html",
};

/** The extension for a MIME type, `.bin` when we have never heard of it. Always leading-dot. */
export function extensionForMime(mime: string | undefined | null): string {
  const type = (mime ?? "").split(";")[0].trim().toLowerCase();
  return MIME_EXTENSIONS[type] ?? ".bin";
}

/**
 * Fold a browser-supplied filename into one safe path segment, or `null` when nothing usable is
 * left.
 *
 * What it removes, and why each one matters:
 *
 * - **separators** — both `/` and `\`, whatever platform we are on: a Windows browser can send
 *   `..\..\.ssh\authorized_keys`, and a POSIX `path.basename` would hand that back unchanged.
 * - **`..` as a whole name** — and any leading dots, so neither traversal nor a dotfile
 *   (`.bashrc`, `.git/config` once a separator is gone) can be created by naming one.
 * - **control characters and NUL** — a name that lies about its own length in a C API.
 * - **trailing dots and spaces** — silently stripped by Windows filesystems, which is how
 *   `evil.exe.` becomes `evil.exe` somewhere downstream.
 *
 * What it deliberately keeps: unicode. `отчёт.pdf` and `スクリーンショット.png` are ordinary
 * filenames, and mangling them into `-----.pdf` would be a bug the operator has to work around.
 */
export function sanitizeFilename(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  // Take the last segment under *both* separator conventions before anything else, so an absolute
  // path ("/etc/passwd", "C:\\Windows\\x") and a relative traversal collapse to their final name.
  const segment = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = segment
    // eslint-disable-next-line no-control-regex -- the point is to strip control characters
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^[.\s]+/, "")   // no leading dots: no `..`, no dotfiles
    .replace(/[.\s]+$/, "")   // no trailing dots or spaces: Windows strips them for us otherwise
    .trim();
  if (cleaned === "") return null;

  // Length is bounded with the extension preserved: truncating "report.pdf" to "report.p" would
  // hand the agent a file its tools cannot recognise.
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const ext = path.extname(cleaned).slice(0, 16);
  const stem = cleaned.slice(0, Math.max(1, MAX_NAME_LENGTH - ext.length));
  return `${stem}${ext}`;
}

/**
 * A name for a payload that has none: `pasted-<timestamp>.<ext>`.
 *
 * This is the clipboard-image case. The timestamp makes it sortable and unique-ish, and the
 * extension comes from the MIME type rather than from a guess — an agent asked to look at
 * `pasted-2026-08-04T11-02-33-125Z.png` knows what it is holding.
 */
export function generatedName(mime: string | undefined | null, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `pasted-${stamp}${extensionForMime(mime)}`;
}

/**
 * The final filename for an upload: the browser's name when it is usable, a generated one when it is
 * not, and the MIME type's extension appended when the name has none (a drop can produce `image`
 * with `image/png` behind it).
 */
export function attachmentFilename(
  filename: string | undefined | null,
  mime: string | undefined | null,
  now: Date = new Date(),
): string {
  const safe = sanitizeFilename(filename);
  // "blob" is not a name, it is what a browser calls a `Blob` it was handed with no name — a
  // clipboard payload, in other words. Treat it as the nameless case it is.
  if (safe === null || safe.toLowerCase() === "blob") return generatedName(mime, now);
  if (path.extname(safe) !== "") return safe;
  return `${safe}${extensionForMime(mime)}`;
}

/** What `AttachmentStore.save` is given: one file's bytes, plus whatever the browser claimed. */
export interface AttachmentInput {
  /** The browser's filename. Untrusted, and absent for a clipboard image. */
  filename?: string | undefined;
  /** The browser's MIME type. Used only to pick an extension, never trusted as a fact. */
  mime?: string | undefined;
  bytes: Uint8Array;
}

/**
 * Writes uploads into `<root>/attachments/`, where `root` is a project root **or a room folder that
 * may live anywhere on disk**. That is why every call takes the root explicitly: there is no single
 * containing directory to validate against, so each write is validated against *its own* root.
 */
export class AttachmentStore {
  constructor(private readonly maxBytes: number = MAX_ATTACHMENT_BYTES) {}

  /**
   * Write one file and answer with where it landed.
   *
   * Throws — with a message meant for the operator — when the payload is empty, over the cap, or
   * when the resolved destination escapes `root`. The last one cannot happen given
   * `sanitizeFilename`, and is checked anyway: it is the layer that still holds if the sanitiser is
   * ever loosened.
   */
  save(root: string, input: AttachmentInput, now: Date = new Date()): SavedAttachment {
    if (!path.isAbsolute(root)) throw new Error(`attachment root must be an absolute path: ${root}`);
    if (input.bytes.byteLength === 0) throw new Error("refusing to write an empty file");
    if (input.bytes.byteLength > this.maxBytes) {
      throw new Error(
        `file is ${input.bytes.byteLength} bytes, over the ${this.maxBytes}-byte attachment limit`,
      );
    }

    const base = path.resolve(root);
    const dir = path.resolve(base, ATTACHMENTS_DIRNAME);
    // Containment, layer two — the same check `RoomManager.createRoom` does on a room folder.
    if (!within(base, dir)) throw new Error(`attachment folder escapes ${base}`);

    const name = attachmentFilename(input.filename, input.mime, now);
    mkdirSync(dir, { recursive: true });

    for (let attempt = 0; attempt < MAX_UNIQUIFY_TRIES; attempt++) {
      const candidate = attempt === 0 ? name : suffixed(name, attempt + 1);
      const full = path.resolve(dir, candidate);
      // Re-checked per candidate rather than once: `full` is what actually gets written, and a
      // check on a value other than the one used is not a check.
      if (!within(dir, full)) throw new Error(`attachment ${JSON.stringify(candidate)} escapes ${dir}`);
      try {
        // "wx": create, and fail if it is already there. Never overwrite the operator's file, and
        // never lose a race between two uploads of the same name — the loser tries the next suffix.
        writeFileSync(full, input.bytes, { flag: "wx" });
        return { name: candidate, path: full, bytes: input.bytes.byteLength };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new Error(`could not find a free name for ${JSON.stringify(name)} in ${dir}`);
  }
}

/** `child` is `parent` itself or strictly inside it. Both must already be resolved. */
function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/** `shot.png` + 2 -> `shot-2.png`; a name with no extension just gains the suffix. */
function suffixed(name: string, n: number): string {
  const ext = path.extname(name);
  const stem = ext === "" ? name : name.slice(0, -ext.length);
  return `${stem}-${n}${ext}`;
}
