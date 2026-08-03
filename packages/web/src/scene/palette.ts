import type { FactoryStatus } from "../store";

/**
 * The floor's colour vocabulary, declared exactly once. The beacon above a roof, the figure of an
 * agent and any future HUD badge all read from here — a status colour that means "blocked" on the
 * beacon and something else on a badge would make the whole surface unreadable, and the only way to
 * prevent that is for there to be one table.
 *
 * The choice is a traffic light plus a quiet default, which is what a factory operator already knows
 * how to read at a glance and across a room:
 *
 * | status | colour | why |
 * |---|---|---|
 * | `idle` | desaturated slate | quiet, not alarming: nothing is wrong with an idle agent |
 * | `working` | green | running, hands off |
 * | `blocked` | amber | *you* have to answer something |
 * | `error` | red | it failed |
 *
 * This deviates from the plan's "working amber, blocked orange": amber and orange are the same hue
 * family, and `blocked` and `error` are the two states an operator must never confuse (one wants an
 * answer, the other wants a fix). Green/amber/red separates all three by hue, and nothing else on
 * the floor is green, amber or red.
 */
export const STATUS_COLOR: Record<FactoryStatus, string> = {
  idle: "#8b959d",
  working: "#25c26e",
  blocked: "#ffb02e",
  error: "#ec3b3b",
};

/**
 * How hard each status glows. `idle` is deliberately barely lit — an idle factory should look calm,
 * and an emissive grey dot that glows as hard as an error reads as an alarm you learn to ignore.
 */
export const STATUS_EMISSIVE: Record<FactoryStatus, number> = {
  idle: 0.25,
  working: 1.3,
  blocked: 1.6,
  error: 1.6,
};

/**
 * The marker on an agent that runs with `bypass` autonomy — nothing it does is gated. Magenta is
 * used for nothing else in the scene on purpose: "which of my agents are ungated" is a question the
 * operator must be able to answer from across the floor, without reading a label.
 */
export const BYPASS_COLOR = "#ff2d95";

/** The package meshes travelling the belts, and the belts themselves. */
export const BELT_COLOR = "#4a5158";
export const SLAT_COLOR = "#6d757d";
export const PACKAGE_COLOR = "#c58a4a";
