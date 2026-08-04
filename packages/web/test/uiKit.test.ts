import { describe, expect, it } from "vitest";

/**
 * The vendored kit's export surface, asserted rather than assumed.
 *
 * These modules are our own source (shadcn's model), so nothing upstream stops a rename — and a
 * renamed export fails at a call site far from the file that changed. jsdom cannot usefully mount a
 * Radix portal, so what is tested is the contract every consumer imports against, in the idiom of
 * `sceneOverlay.test.ts`: this package tests the source and the data, not a mount.
 */
const EXPECTED: Record<string, readonly string[]> = {
  tooltip: ["Tooltip", "TooltipTrigger", "TooltipContent", "TooltipProvider", "Hint"],
  tabs: ["Tabs", "TabsList", "TabsTrigger"],
  "scroll-area": ["ScrollArea"],
  separator: ["Separator"],
  card: ["Card", "CardHeader", "CardTitle", "CardBody"],
  progress: ["Progress"],
  dialog: ["Dialog", "DialogTrigger", "DialogContent", "DialogTitle", "DialogDescription"],
  alert: ["Alert", "AlertTitle"],
};

describe("the vendored ui kit", () => {
  for (const [name, exports] of Object.entries(EXPECTED)) {
    it(`${name} exports what its consumers import`, async () => {
      // The extension is in the static part on purpose: without it Vite cannot analyse the glob and
      // warns on every run.
      const mod = await import(`../src/ui/${name}.tsx`);
      for (const exported of exports) {
        expect(mod[exported], `${name}.${exported}`).toBeTypeOf("function");
      }
    });
  }
});
