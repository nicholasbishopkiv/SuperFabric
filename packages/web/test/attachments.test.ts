import type { SavedAttachment } from "@superfabric/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeTurn, dragHasFiles, uploadFiles, uploadIntoComposer } from "../src/attachments";
import { initialFabricState, useFabric } from "../src/store";

const saved = (over: Partial<SavedAttachment> = {}): SavedAttachment => ({
  name: "shot.png", path: "/p/attachments/shot.png", bytes: 12, ...over,
});

beforeEach(() => {
  useFabric.setState({ ...initialFabricState, staged: [], projects: [], activeProjectId: null });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("staging attachments", () => {
  it("stages what an upload saved, as removable chips", () => {
    const s = useFabric.getState();
    s.stageAttachments([saved(), saved({ name: "notes.txt", path: "/p/attachments/notes.txt", bytes: 3 })]);
    expect(useFabric.getState().staged).toEqual([
      { name: "shot.png", path: "/p/attachments/shot.png", bytes: 12 },
      { name: "notes.txt", path: "/p/attachments/notes.txt", bytes: 3 },
    ]);

    useFabric.getState().unstageAttachment("/p/attachments/shot.png");
    expect(useFabric.getState().staged.map((a) => a.name)).toEqual(["notes.txt"]);

    // Unstaging is about the message, not the disk: nothing here deletes anything.
    useFabric.getState().clearStagedAttachments();
    expect(useFabric.getState().staged).toEqual([]);
  });

  it("never chips the same file twice — a drop event can fire more than once", () => {
    useFabric.getState().stageAttachments([saved()]);
    useFabric.getState().stageAttachments([saved()]);
    expect(useFabric.getState().staged).toHaveLength(1);
  });

  it("leaves the list identity alone when nothing changed", () => {
    useFabric.getState().stageAttachments([saved()]);
    const before = useFabric.getState().staged;
    useFabric.getState().unstageAttachment("/p/attachments/not-staged.png");
    expect(useFabric.getState().staged).toBe(before);
  });

  it("drops the staged files when the tab switches factory", () => {
    useFabric.setState({ activeProjectId: "p1" });
    useFabric.getState().stageAttachments([saved()]);
    // A path in one project's folder is meaningless to an agent on another floor.
    useFabric.getState().applyProjects(
      [
        { id: "p1", name: "A", root: "/a", lastOpenedAt: 1 },
        { id: "p2", name: "B", root: "/b", lastOpenedAt: 2 },
      ],
      "p2",
    );
    expect(useFabric.getState().staged).toEqual([]);
  });
});

describe("composeTurn", () => {
  it("names each file's absolute path on its own line", () => {
    const text = composeTurn("look at this", [
      { name: "shot.png", path: "/p/attachments/shot.png", bytes: 1 },
      { name: "log.txt", path: "/srv/other/attachments/log.txt", bytes: 2 },
    ]);
    expect(text).toBe(
      "look at this\n\nAttached file: /p/attachments/shot.png\nAttached file: /srv/other/attachments/log.txt",
    );
  });

  it("allows a send with attachments and no text at all", () => {
    expect(composeTurn("", [{ name: "shot.png", path: "/p/attachments/shot.png", bytes: 1 }]))
      .toBe("Attached file: /p/attachments/shot.png");
    expect(composeTurn("   ", [{ name: "a", path: "/p/a", bytes: 1 }])).toBe("Attached file: /p/a");
  });

  it("is plain text when nothing is attached, and null when there is nothing at all", () => {
    expect(composeTurn("  hello  ", [])).toBe("hello");
    expect(composeTurn("", [])).toBe(null);
    expect(composeTurn("   ", [])).toBe(null);
  });
});

describe("uploadFiles", () => {
  it("posts the fields before the files, and returns what the server saved", async () => {
    let seen: { url: string; body: FormData } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen = { url, body: init.body as FormData };
      return new Response(JSON.stringify({ saved: [saved()] }), { status: 200 });
    });

    const file = new File(["bytes"], "shot.png", { type: "image/png" });
    const out = await uploadFiles([file], { projectId: "p1", roomId: "r1" });

    expect(out).toEqual([saved()]);
    expect(seen!.url).toBe("/attachments");
    // Order matters: the server streams the parts and must know the destination before the bytes.
    const keys = [...seen!.body.keys()];
    expect(keys).toEqual(["projectId", "roomId", "file"]);
    expect(seen!.body.get("projectId")).toBe("p1");
    expect(seen!.body.get("roomId")).toBe("r1");
  });

  it("omits roomId when no room is selected, so the file lands in the project root", async () => {
    let body: FormData | null = null;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = init.body as FormData;
      return new Response(JSON.stringify({ saved: [] }), { status: 200 });
    });
    await uploadFiles([new File(["x"], "a.txt")], { projectId: "p1", roomId: null });
    expect([...body!.keys()]).toEqual(["projectId", "file"]);
  });

  it("throws with the server's own message on a rejection", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: "forbidden origin" }), { status: 403 }));
    await expect(uploadFiles([new File(["x"], "a.txt")], { projectId: "p1" }))
      .rejects.toThrow("forbidden origin");
  });
});

describe("uploadIntoComposer", () => {
  it("stages the saved paths and reports nothing on the error channel", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ saved: [saved()] }), { status: 200 }));
    useFabric.setState({ activeProjectId: "p1", selectedRoomId: null });

    await uploadIntoComposer([new File(["x"], "shot.png", { type: "image/png" })]);

    expect(useFabric.getState().staged).toEqual([saved()]);
    expect(useFabric.getState().lastError).toBe(null);
    expect(useFabric.getState().uploading).toBe(false);
  });

  it("sends the selected room, so the file lands in that room's folder", async () => {
    let body: FormData | null = null;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = init.body as FormData;
      return new Response(JSON.stringify({ saved: [] }), { status: 200 });
    });
    useFabric.setState({ activeProjectId: "p1", selectedRoomId: "r9" });
    await uploadIntoComposer([new File(["x"], "a.txt")]);
    expect(body!.get("roomId")).toBe("r9");
  });

  it("reports a failure instead of staging anything", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: "big.bin is over the limit" }), { status: 413 }));
    useFabric.setState({ activeProjectId: "p1" });

    await uploadIntoComposer([new File(["x"], "big.bin")]);

    expect(useFabric.getState().staged).toEqual([]);
    expect(useFabric.getState().lastError).toBe("big.bin is over the limit");
    expect(useFabric.getState().uploading).toBe(false);
  });

  it("refuses to upload before the server has said which factory this tab is on", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await uploadIntoComposer([new File(["x"], "a.txt")]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useFabric.getState().lastError).toMatch(/no project/);
  });

  it("does nothing at all for an empty selection", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await uploadIntoComposer([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("notices", () => {
  it("keeps the server's notice apart from its errors", () => {
    useFabric.getState().apply({ kind: "notice", message: "attachment saved to /p/attachments/a.png" });
    expect(useFabric.getState().lastNotice).toBe("attachment saved to /p/attachments/a.png");
    expect(useFabric.getState().lastError).toBe(null);

    useFabric.getState().apply({ kind: "error", message: "nope" });
    expect(useFabric.getState().lastError).toBe("nope");
    // an error does not erase the notice, and clearing one does not clear the other
    expect(useFabric.getState().lastNotice).toBe("attachment saved to /p/attachments/a.png");
    useFabric.getState().clearNotice();
    expect(useFabric.getState().lastNotice).toBe(null);
    expect(useFabric.getState().lastError).toBe("nope");
  });
});

describe("dragHasFiles", () => {
  it("is true only for a drag that actually carries files", () => {
    expect(dragHasFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(dragHasFiles({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
  });
});
