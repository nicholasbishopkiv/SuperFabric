import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { ATTACHMENTS_DIRNAME } from "@superfabric/shared";
import { registerAttachmentRoutes } from "../src/attachmentRoutes.js";
import { openDb } from "../src/db.js";
import { ProjectManager } from "../src/projectManager.js";
import { RoomManager } from "../src/roomManager.js";

/**
 * The upload endpoint end to end, over Fastify's own request pipeline (`app.inject`) so the
 * `onRequest` origin gate, the content-type parser and the handler all run exactly as they do in
 * production. The multipart body is built by hand — the same bytes a browser's `FormData` produces —
 * and Bun's `Request.formData()` is what parses it on the far side, which is the whole point of
 * testing it here rather than trusting that it works.
 */

const PORT = 4620;

/** Multipart parts: text fields and files, encoded the way a browser encodes them. */
type Part =
  | { field: string; value: string }
  | { field: string; filename: string; type: string; body: Uint8Array | string };

function multipart(parts: Part[]): { body: Buffer; contentType: string } {
  const boundary = "----superfabricTestBoundary9f2c";
  const chunks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const part of parts) {
    if ("value" in part) {
      chunks.push(enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"\r\n\r\n${part.value}\r\n`,
      ));
      continue;
    }
    chunks.push(enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"; `
      + `filename="${part.filename}"\r\nContent-Type: ${part.type}\r\n\r\n`,
    ));
    chunks.push(typeof part.body === "string" ? enc.encode(part.body) : part.body);
    chunks.push(enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks.map((c) => Buffer.from(c))),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

interface Ctx {
  app: FastifyInstance;
  projectRoot: string;
  /** A room folder deliberately *outside* the project root — supported since M1b. */
  outsideRoot: string;
  projectId: string;
  otherProjectId: string;
  insideRoomId: string;
  outsideRoomId: string;
  otherProjectRoomId: string;
  notices: { projectId: string; message: string }[];
  cleanup(): void;
}

let ctx: Ctx;

function build(maxBytes?: number): Ctx {
  const projectRoot = mkdtempSync(join(tmpdir(), "superfabric-up-project-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "superfabric-up-outside-"));
  const otherRoot = mkdtempSync(join(tmpdir(), "superfabric-up-other-"));
  const db = openDb(":memory:");
  const projects = new ProjectManager(db, projectRoot);
  const rooms = new RoomManager(db, projects);
  const projectId = projects.defaultProject().id;
  const otherProjectId = projects.create({ root: otherRoot }).id;
  const insideRoomId = rooms.createRoom("backend", { projectId }).id;
  const outsideRoomId = rooms.createRoom("payments", { projectId, path: outsideRoot }).id;
  const otherProjectRoomId = rooms.createRoom("backend", { projectId: otherProjectId }).id;

  const notices: { projectId: string; message: string }[] = [];
  const app = Fastify();
  registerAttachmentRoutes(app, {
    projects, rooms, port: PORT,
    notify: (p, message) => notices.push({ projectId: p, message }),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });

  return {
    app, projectRoot, outsideRoot, projectId, otherProjectId,
    insideRoomId, outsideRoomId, otherProjectRoomId, notices,
    cleanup: () => {
      db.close();
      for (const dir of [projectRoot, outsideRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** POST a multipart upload from a browser at `origin` (undefined = a non-browser client). */
async function upload(
  parts: Part[],
  origin: string | undefined = "http://localhost:5173",
): Promise<{ status: number; body: any }> {
  const { body, contentType } = multipart(parts);
  const res = await ctx.app.inject({
    method: "POST",
    url: "/attachments",
    headers: {
      "content-type": contentType,
      "content-length": String(body.byteLength),
      ...(origin === undefined ? {} : { origin }),
    },
    payload: body,
  });
  return { status: res.statusCode, body: res.body === "" ? null : JSON.parse(res.body) };
}

beforeEach(() => { ctx = build(); });
afterEach(async () => { await ctx.app.close(); ctx.cleanup(); });

describe("POST /attachments", () => {
  it("writes the file into the project's attachments folder and answers with the path", async () => {
    const res = await upload([
      { field: "projectId", value: ctx.projectId },
      { field: "file", filename: "notes.txt", type: "text/plain", body: "the bytes" },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.saved).toHaveLength(1);
    const saved = res.body.saved[0];
    expect(saved.path).toBe(join(ctx.projectRoot, ATTACHMENTS_DIRNAME, "notes.txt"));
    expect(saved.name).toBe("notes.txt");
    expect(readFileSync(saved.path, "utf8")).toBe("the bytes");
  });

  it("says where the file landed on the notice channel", async () => {
    const res = await upload([
      { field: "projectId", value: ctx.projectId },
      { field: "file", filename: "notes.txt", type: "text/plain", body: "x" },
    ]);
    expect(ctx.notices).toEqual([
      { projectId: ctx.projectId, message: `attachment saved to ${res.body.saved[0].path}` },
    ]);
  });

  it("routes into the selected room's folder, including one outside the project root", async () => {
    const inside = await upload([
      { field: "projectId", value: ctx.projectId },
      { field: "roomId", value: ctx.insideRoomId },
      { field: "file", filename: "a.txt", type: "text/plain", body: "a" },
    ]);
    expect(inside.body.saved[0].path).toBe(join(ctx.projectRoot, "backend", ATTACHMENTS_DIRNAME, "a.txt"));

    const outside = await upload([
      { field: "projectId", value: ctx.projectId },
      { field: "roomId", value: ctx.outsideRoomId },
      { field: "file", filename: "b.txt", type: "text/plain", body: "b" },
    ]);
    // The room's folder is not under the project root at all, and that is legal since M1b: the
    // containment check is against the *room's own* root.
    expect(ctx.outsideRoot.startsWith(ctx.projectRoot + sep)).toBe(false);
    expect(outside.body.saved[0].path).toBe(join(ctx.outsideRoot, ATTACHMENTS_DIRNAME, "b.txt"));
    expect(readFileSync(outside.body.saved[0].path, "utf8")).toBe("b");
  });

  it("refuses a room belonging to another factory", async () => {
    const res = await upload([
      { field: "projectId", value: ctx.projectId },
      { field: "roomId", value: ctx.otherProjectRoomId },
      { field: "file", filename: "a.txt", type: "text/plain", body: "a" },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/belongs to another project/);
  });

  it("refuses an unknown project or room", async () => {
    const noProject = await upload([
      { field: "projectId", value: "nope" },
      { field: "file", filename: "a.txt", type: "text/plain", body: "a" },
    ]);
    expect(noProject.status).toBe(404);
    const noRoom = await upload([
      { field: "projectId", value: ctx.projectId },
      { field: "roomId", value: "nope" },
      { field: "file", filename: "a.txt", type: "text/plain", body: "a" },
    ]);
    expect(noRoom.status).toBe(404);
  });

  it("sanitises the browser's filename and never escapes the destination", async () => {
    const res = await upload([
      { field: "projectId", value: ctx.projectId },
      { field: "file", filename: "../../escape.txt", type: "text/plain", body: "x" },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.saved[0].path).toBe(join(ctx.projectRoot, ATTACHMENTS_DIRNAME, "escape.txt"));
    expect(existsSync(join(ctx.projectRoot, "escape.txt"))).toBe(false);
  });

  it("names a clipboard image from the timestamp and its MIME type", async () => {
    // A pasted image arrives with no filename at all; the browser's FormData still sends one, and
    // "blob" is what Chrome uses, so both spellings of "nameless" have to work.
    const res = await upload([
      { field: "projectId", value: ctx.projectId },
      { field: "file", filename: "", type: "image/png", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.saved[0].name).toMatch(/^pasted-.*\.png$/);
    expect(new Uint8Array(readFileSync(res.body.saved[0].path)))
      .toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it("uniquifies rather than overwriting", async () => {
    const parts: Part[] = [
      { field: "projectId", value: ctx.projectId },
      { field: "file", filename: "shot.png", type: "image/png", body: "first" },
    ];
    const one = await upload(parts);
    const two = await upload([
      { field: "projectId", value: ctx.projectId },
      { field: "file", filename: "shot.png", type: "image/png", body: "second" },
    ]);
    expect(one.body.saved[0].name).toBe("shot.png");
    expect(two.body.saved[0].name).toBe("shot-2.png");
    expect(readFileSync(one.body.saved[0].path, "utf8")).toBe("first");
  });

  it("takes several files in one upload", async () => {
    const res = await upload([
      { field: "projectId", value: ctx.projectId },
      { field: "file", filename: "a.txt", type: "text/plain", body: "a" },
      { field: "file", filename: "b.txt", type: "text/plain", body: "b" },
    ]);
    expect(res.body.saved.map((s: { name: string }) => s.name)).toEqual(["a.txt", "b.txt"]);
    expect(ctx.notices).toHaveLength(2);
  });

  it("refuses an upload with no file and one with no project", async () => {
    const noFile = await upload([{ field: "projectId", value: ctx.projectId }]);
    expect(noFile.status).toBe(400);
    expect(noFile.body.error).toMatch(/no file/);
    const noProject = await upload([
      { field: "file", filename: "a.txt", type: "text/plain", body: "a" },
    ]);
    expect(noProject.status).toBe(400);
    expect(noProject.body.error).toMatch(/projectId/);
  });

  describe("the size cap", () => {
    beforeEach(async () => { await ctx.app.close(); ctx.cleanup(); ctx = build(64); });

    it("rejects a file over the cap with a clear error and writes nothing", async () => {
      const res = await upload([
        { field: "projectId", value: ctx.projectId },
        { field: "file", filename: "big.bin", type: "application/octet-stream", body: new Uint8Array(200) },
      ]);
      expect(res.status).toBe(413);
      expect(res.body.error).toMatch(/over the 64-byte limit/);
      expect(existsSync(join(ctx.projectRoot, ATTACHMENTS_DIRNAME, "big.bin"))).toBe(false);
    });

    it("still takes a file at the cap", async () => {
      const res = await upload([
        { field: "projectId", value: ctx.projectId },
        { field: "file", filename: "ok.bin", type: "application/octet-stream", body: new Uint8Array(64) },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.saved[0].bytes).toBe(64);
    });
  });

  describe("the origin gate — as strict as the WebSocket handshake", () => {
    it("rejects a disallowed browser origin with 403 and writes nothing", async () => {
      for (const origin of ["https://evil.example.com", "http://localhost:5174", "null"]) {
        const res = await upload([
          { field: "projectId", value: ctx.projectId },
          { field: "file", filename: "drive-by.txt", type: "text/plain", body: "x" },
        ], origin);
        expect(res.status, origin).toBe(403);
      }
      expect(existsSync(join(ctx.projectRoot, ATTACHMENTS_DIRNAME))).toBe(false);
      expect(ctx.notices).toEqual([]);
    });

    it("accepts the allowed origins", async () => {
      for (const origin of [
        "http://localhost:5173", "http://127.0.0.1:5173",
        `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
        undefined, // a non-browser client sends none, exactly as origin.ts allows on the socket
      ]) {
        const res = await upload([
          { field: "projectId", value: ctx.projectId },
          { field: "file", filename: "ok.txt", type: "text/plain", body: "x" },
        ], origin);
        expect(res.status, String(origin)).toBe(200);
      }
    });
  });
});
