import { BYPASS_COLOR, SELECT_COLOR, STATUS_COLOR } from "../scene/palette";

/**
 * The bridge between the floor's colour table and the HUD's stylesheet.
 *
 * `scene/palette.ts` owns the status colours, selection and the bypass marker; the 3D side reads
 * them as strings, and the 2D side needs them as CSS. Rather than write the same hex twice — which
 * is how a room's dot in a panel ends up disagreeing with its beacon on the roof — the tokens are
 * *generated* from that one table and written onto `:root` before React paints. `index.css` then
 * declares its Tailwind colour tokens as `var(--sf-…)` references to these, so `bg-status-blocked`
 * and the amber on a beacon are the same number by construction.
 *
 * This runs at boot rather than being emitted at build time on purpose: `palette.ts` is TypeScript
 * that other code imports, and a build step that parsed it into CSS would be a second thing to keep
 * in sync. One `for` loop is cheaper than a generator.
 */
export const HUD_TOKENS: Readonly<Record<string, string>> = {
  "--sf-status-idle": STATUS_COLOR.idle,
  "--sf-status-working": STATUS_COLOR.working,
  "--sf-status-paused": STATUS_COLOR.paused,
  "--sf-status-blocked": STATUS_COLOR.blocked,
  "--sf-status-error": STATUS_COLOR.error,
  /** Selection — the one colour the HUD points with, and the same cyan the floor selects in. */
  "--sf-accent": SELECT_COLOR,
  "--sf-bypass": BYPASS_COLOR,
};

/** Write the tokens onto the document root. Idempotent; called once from `main.tsx`. */
export function installHudTokens(root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(HUD_TOKENS)) root.style.setProperty(name, value);
}
