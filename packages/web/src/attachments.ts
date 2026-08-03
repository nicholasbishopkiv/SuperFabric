import type { AttachmentUploadResult, SavedAttachment } from "@superfabric/shared";
import type { StagedAttachment } from "./store";
import { useFabric } from "./store";

/**
 * Files in, paths out — the browser half.
 *
 * A paste, a drop or an upload sends the bytes to `POST /attachments` over plain HTTP (the socket's
 * `maxPayload` is 1 MiB and its protocol is JSON, so binary there would mean base64), and the
 * server answers with the **absolute path** each file landed on. Nothing binary ever touches the
 * WebSocket, and the transcript never carries a byte of it.
 *
 * What comes back is *staged*, not sent: the operator almost always wants to say something about
 * the file they just dropped. `composeTurn` is what finally folds the staged paths into the turn
 * text, and it is deliberately a pure function so what an agent receives is testable without a
 * browser.
 */

/** Where the endpoint lives. Same origin as the app, so the Vite dev server proxies it. */
const UPLOAD_URL = "/attachments";

/**
 * The line an agent actually reads. One per file, absolute path, no ceremony: an agent with file
 * tools needs a path it can open, and anything more decorative is something for it to parse.
 */
function attachmentLine(path: string): string {
  return `Attached file: ${path}`;
}

/**
 * The text of the turn the operator is sending: what they typed, then a line per staged file.
 *
 * `null` means "there is nothing to send" — no text *and* no attachments. A send with attachments
 * and no text is legitimate and common (drop a screenshot, hit send), so it must not be refused.
 */
export function composeTurn(text: string, staged: readonly StagedAttachment[]): string | null {
  const typed = text.trim();
  if (staged.length === 0) return typed === "" ? null : typed;
  const lines = staged.map((a) => attachmentLine(a.path)).join("\n");
  return typed === "" ? lines : `${typed}\n\n${lines}`;
}

/** Everything `uploadFiles` needs to know beyond the files themselves. */
export interface UploadTarget {
  projectId: string;
  /** The selected room; the file lands in that room's folder instead of the project root. */
  roomId?: string | null;
}

/**
 * POST the files and return what the server saved. Throws with the server's own message on failure —
 * the caller decides whether that is an error to show or one to swallow.
 *
 * The fields go in **before** the files on purpose: the server streams the parts and needs to know
 * where the bytes are going before the first one arrives.
 */
export async function uploadFiles(files: readonly File[], target: UploadTarget): Promise<SavedAttachment[]> {
  const form = new FormData();
  form.append("projectId", target.projectId);
  if (target.roomId !== undefined && target.roomId !== null) form.append("roomId", target.roomId);
  for (const file of files) form.append("file", file, file.name);

  const res = await fetch(UPLOAD_URL, { method: "POST", body: form });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = typeof (body as { error?: unknown })?.error === "string"
      ? (body as { error: string }).error
      : `upload failed (${res.status})`;
    throw new Error(message);
  }
  return ((body ?? { saved: [] }) as AttachmentUploadResult).saved;
}

/**
 * The whole gesture: upload whatever the operator produced, stage the paths, and say so if it went
 * wrong. Used by paste, by drop and by the console's file input, because they differ only in how
 * they got hold of a `File`.
 *
 * The destination is read from the store at call time — the active project, and the selected room
 * if there is one — so dropping a file while a room is selected puts it in that room's folder,
 * which is the whole point of having selected it.
 */
export async function uploadIntoComposer(files: readonly File[]): Promise<void> {
  if (files.length === 0) return;
  const state = useFabric.getState();
  if (state.activeProjectId === null) {
    state.setError("no project is open yet — wait for the server");
    return;
  }
  state.setUploading(true);
  try {
    const saved = await uploadFiles(files, {
      projectId: state.activeProjectId,
      roomId: state.selectedRoomId,
    });
    // The server also sends a `notice` naming each path; this is what puts the chips in the box.
    useFabric.getState().stageAttachments(saved);
  } catch (err) {
    useFabric.getState().setError(err instanceof Error ? err.message : String(err));
  } finally {
    useFabric.getState().setUploading(false);
  }
}

/**
 * The files carried by a paste, or `[]` when the clipboard holds only text.
 *
 * A clipboard image has no filename — `DataTransferItem.getAsFile()` hands back a `File` the
 * browser named `image.png` at best and `blob` at worst — which is exactly why the server names it
 * from the timestamp and the MIME type rather than trusting this.
 */
export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (data === null) return [];
  const out: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null) out.push(file);
  }
  // Some browsers populate `files` and not `items`; belt and braces, without duplicating.
  if (out.length === 0) out.push(...data.files);
  return out;
}

/** Whether a drag carries files at all, so a dragged text selection does not arm the drop target. */
export function dragHasFiles(data: DataTransfer | null): boolean {
  if (data === null) return false;
  return [...data.types].includes("Files");
}
