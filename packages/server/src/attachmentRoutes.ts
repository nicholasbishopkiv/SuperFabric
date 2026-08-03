import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MAX_ATTACHMENT_BYTES, type SavedAttachment } from "@superfabric/shared";
import { AttachmentStore } from "./attachmentStore.js";
import { isOriginAllowed } from "./origin.js";
import type { ProjectManager } from "./projectManager.js";
import type { RoomManager } from "./roomManager.js";

/**
 * `POST /attachments` — the one place bytes enter SuperFabric.
 *
 * **Why HTTP and not the WebSocket.** The socket speaks JSON, so binary would have to be base64 (a
 * third bigger, in one giant frame), and its `maxPayload` is deliberately 1 MiB because the largest
 * legitimate frame is a prompt. Fastify is already listening on the same port, so a multipart POST
 * costs no new port and no new process — but it *is* new attack surface, so it is gated exactly as
 * hard as the socket is:
 *
 * - **the same origin allow-list as the WebSocket handshake**, from the same `origin.ts`. This
 *   endpoint writes files into the operator's repository; if it were weaker than the socket, the
 *   drive-by website the socket's check exists to stop would simply use this instead. The check runs
 *   in `onRequest`, before a single byte of the body is read.
 * - **a size cap**, enforced three times: on `content-length` before reading, by the multipart
 *   parser while streaming, and on the real byte count in `AttachmentStore`.
 * - **the filename is untrusted** and goes through `AttachmentStore` — sanitised to one path
 *   segment, re-checked against the destination root, and never overwriting anything.
 *
 * **Why `@fastify/multipart` and not Bun's own `Request.formData()`.** The obvious dependency-free
 * route is to buffer the body and hand it to the runtime's own multipart parser. It parses fine
 * under Bun — but **Bun's `formData()` discards each part's `Content-Type` header and re-derives
 * `File.type` from the filename extension**, which is precisely backwards for the case this feature
 * exists for: a pasted clipboard image has *no* filename, so its extension has to come from the
 * declared type. Bun hands back `type: ""` for it and every screenshot would land as `.bin`.
 * `@fastify/multipart` (busboy) reads the part headers properly, works under Bun's `node:http`
 * shim — verified through `app.inject()` and over a real socket — and brings the streaming size
 * limit with it. It is MIT.
 */

/** How many files one upload may carry. A paste or a drop is a handful, never a directory. */
const MAX_FILES_PER_UPLOAD = 10;

/** Multipart framing overhead allowance on top of the byte caps, for boundaries and part headers. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export interface AttachmentRouteDeps {
  projects: ProjectManager;
  rooms: RoomManager;
  /** The port the server is listening on — the origin allow-list is relative to it. */
  port: number;
  /** `SUPERFABRIC_ALLOWED_ORIGINS`, the same value the WebSocket handshake uses. */
  allowedOrigins?: string | undefined;
  /**
   * Tell the operator where a file landed. The upload's own answer carries the path too, but a
   * `notice` reaches every tab on that floor, and it is the channel this protocol now has for
   * "it worked". Optional so a test can mount the route without a hub.
   */
  notify?: ((projectId: string, message: string) => void) | undefined;
  store?: AttachmentStore | undefined;
  maxBytes?: number | undefined;
}

/** A request that got past the origin gate but is malformed: answered with a status and a reason. */
class BadUpload extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function registerAttachmentRoutes(app: FastifyInstance, deps: AttachmentRouteDeps): void {
  const maxBytes = deps.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const store = deps.store ?? new AttachmentStore(maxBytes);
  const maxUploadBytes = maxBytes * 4;

  void app.register(multipart, {
    limits: { fileSize: maxBytes, files: MAX_FILES_PER_UPLOAD, fields: 8, fieldSize: 4096 },
  });

  app.post(
    "/attachments",
    {
      // Async, and `return reply` is how a Fastify hook says "the lifecycle stops here": the body
      // is never read, which is the point of doing both of these checks in `onRequest`.
      onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
        // Exactly the WebSocket's policy, from the same module. A browser always sends `Origin`;
        // a missing one is a non-browser client, which is the case the WS check also allows.
        const origin = req.headers.origin;
        if (!isOriginAllowed(origin, deps.port, deps.allowedOrigins)) {
          console.warn(`attachments: rejected upload from origin ${String(origin)}`);
          await reply.code(403).send({ error: "forbidden origin" });
          return reply;
        }
        // Refuse an oversized upload before reading it, so neither the disk nor the heap is
        // involved at all. The streaming limit below is what actually protects us; this only
        // saves everyone the transfer.
        const declared = Number(req.headers["content-length"] ?? 0);
        if (Number.isFinite(declared) && declared > maxUploadBytes + MULTIPART_OVERHEAD_BYTES) {
          await reply.code(413).send({
            error: `upload is ${declared} bytes; the limit is ${maxBytes} bytes per file`,
          });
          return reply;
        }
        return undefined;
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const saved = await handleUpload(req, deps, store, maxBytes, maxUploadBytes);
        return await reply.code(200).send({ saved });
      } catch (err) {
        if (err instanceof BadUpload) return await reply.code(err.status).send({ error: err.message });
        // busboy's own limit errors carry a code; everything else is a bad request by elimination.
        const code = (err as { code?: string }).code ?? "";
        if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") {
          return await reply.code(413).send({
            error: `too much: at most ${MAX_FILES_PER_UPLOAD} files and ${maxBytes} bytes each`,
          });
        }
        return await reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}

async function handleUpload(
  req: FastifyRequest,
  deps: AttachmentRouteDeps,
  store: AttachmentStore,
  maxBytes: number,
  maxUploadBytes: number,
): Promise<SavedAttachment[]> {
  if (!req.isMultipart()) throw new BadUpload(415, "expected a multipart/form-data upload");

  let projectId: string | null = null;
  let roomId: string | null = null;
  let root: string | null = null;
  let total = 0;
  const saved: SavedAttachment[] = [];

  // Streamed, one part at a time: at most one file is ever in memory, and the destination is known
  // before anything is written. That is why the fields have to come first — see the error below.
  for await (const part of req.parts()) {
    if (part.type !== "file") {
      const value = typeof part.value === "string" ? part.value.trim() : "";
      if (part.fieldname === "projectId" && value !== "") projectId = value;
      if (part.fieldname === "roomId" && value !== "") roomId = value;
      continue;
    }

    if (projectId === null) {
      throw new BadUpload(400, "projectId must be sent before the file parts");
    }
    root ??= destinationRoot(deps, projectId, roomId);

    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        throw new BadUpload(413, `${part.filename || "file"} is over the ${maxBytes}-byte limit`);
      }
      throw err;
    }
    total += bytes.byteLength;
    if (total > maxUploadBytes) {
      throw new BadUpload(413, `the whole upload is over the ${maxUploadBytes}-byte limit`);
    }
    saved.push(store.save(root, {
      filename: part.filename,
      mime: part.mimetype,
      bytes: new Uint8Array(bytes),
    }));
  }

  if (projectId === null) throw new BadUpload(400, "projectId is required");
  if (saved.length === 0) throw new BadUpload(400, "no file in the upload");

  if (deps.notify !== undefined) {
    for (const s of saved) deps.notify(projectId, `attachment saved to ${s.path}`);
  }
  return saved;
}

/**
 * Where the file goes: the selected room's folder when a room is selected, the project root
 * otherwise — with `attachments/` under it, added by `AttachmentStore`.
 *
 * A room's folder may be anywhere on disk since M1b, so this deliberately does not require the room
 * to sit inside the project root. It *does* require the room to belong to the project the request
 * names, or a client holding another factory's room id could drop files into it.
 */
function destinationRoot(deps: AttachmentRouteDeps, projectId: string, roomId: string | null): string {
  const project = deps.projects.get(projectId);
  if (project === undefined) throw new BadUpload(404, `unknown project ${projectId}`);
  if (roomId === null || roomId === "") return project.root;

  const room = deps.rooms.getRoom(roomId);
  if (room === undefined) throw new BadUpload(404, `unknown room ${roomId}`);
  if (deps.rooms.projectOf(roomId) !== projectId) {
    throw new BadUpload(400, `room ${roomId} belongs to another project`);
  }
  return room.path;
}
