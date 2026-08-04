import { beforeEach, describe, expect, it } from "vitest";
import type { FactoryExport, FactoryImportResult, ServerMessage } from "@superfabric/shared";
import { FACTORY_EXPORT_FORMAT, FACTORY_EXPORT_NOTE, FACTORY_EXPORT_VERSION } from "@superfabric/shared";
import { exportFilename } from "../src/hud/FactoryTransfer";
import { initialFabricState, useFabric } from "../src/store";

/**
 * The pure parts of moving a factory, and how the two answers land in the store.
 *
 * The property held down here is that **an import's report survives**: it is not an error and not a
 * notice, so nothing else on the wire may sweep it away — the operator has to be able to read a
 * reported collision after the floor has finished redrawing itself around them.
 */

const EXPORT: FactoryExport = {
  format: FACTORY_EXPORT_FORMAT,
  version: FACTORY_EXPORT_VERSION,
  exportedAt: Math.floor(Date.parse("2026-08-04T12:00:00Z") / 1000),
  note: FACTORY_EXPORT_NOTE,
  project: { name: "Payments Platform" },
  accountLabels: ["work"],
  rooms: [],
  tasks: [],
  decisions: [],
};

const RESULT: FactoryImportResult = {
  projectId: "p2", projectName: "Payments Platform", projectCreated: true,
  roomsCreated: ["frontend"], tasksCreated: 3, decisionsIndexed: 1, agentsDescribed: 4,
  problems: ['room "backend" was not created: room "backend" already exists'],
};

const apply = (msg: ServerMessage): void => { useFabric.getState().apply(msg); };

beforeEach(() => {
  useFabric.setState({
    ...initialFabricState, factoryExport: null, factoryImport: null, lastError: null,
    projects: [], activeProjectId: null,
  });
});

describe("exportFilename", () => {
  it("is something a downloads folder can be read in", () => {
    expect(exportFilename(EXPORT)).toBe("payments-platform-factory-2026-08-04.json");
  });

  it("survives a project name with nothing filename-shaped in it", () => {
    expect(exportFilename({ ...EXPORT, project: { name: "«…»" } }))
      .toBe("factory-factory-2026-08-04.json");
  });
});

describe("the two answers in the store", () => {
  it("holds an export until whoever saves it clears it, so one export is one file", () => {
    apply({ kind: "factory_export", factory: EXPORT });
    expect(useFabric.getState().factoryExport).toEqual(EXPORT);
    useFabric.getState().clearFactoryExport();
    expect(useFabric.getState().factoryExport).toBeNull();
  });

  it("keeps an import's problems until they are dismissed, and never on the error channel", () => {
    apply({ kind: "factory_import", result: RESULT });
    expect(useFabric.getState().factoryImport!.problems).toHaveLength(1);
    // A reported collision is an outcome, not a failure: painting it red would say the import broke.
    expect(useFabric.getState().lastError).toBeNull();

    // The import moves this socket onto the new floor, which arrives as a `projects` frame — the report
    // must survive it, because that is exactly when the operator is reading it.
    apply({
      kind: "projects",
      projects: [{ id: "p2", name: "Payments Platform", root: "/b", lastOpenedAt: null }],
      activeProjectId: "p2",
    });
    expect(useFabric.getState().factoryImport!.problems).toHaveLength(1);

    useFabric.getState().clearFactoryImport();
    expect(useFabric.getState().factoryImport).toBeNull();
  });
});
