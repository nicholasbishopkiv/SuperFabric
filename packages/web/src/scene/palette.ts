import type { FactoryStatus } from "../store";

/**
 * The floor's colour vocabulary, declared exactly once. The beacon above a roof, the figure of an
 * agent, the concrete under both and any future HUD badge all read from here — a status colour that
 * means "blocked" on the beacon and something else on a badge would make the whole surface
 * unreadable, and the only way to prevent that is for there to be one table.
 *
 * ## The one rule everything else follows
 *
 * **Status wins every read.** The four status colours are load-bearing semantics; everything else on
 * the floor is decoration and must lose to them. That is enforced two ways: the status colours are
 * the only *saturated* colours in the scene (the concrete, the walls and the per-room accents are
 * all under 34% saturation), and the hue band the room accents are drawn from deliberately excludes
 * every status hue. A workshop's identity is allowed to tint its walls; it is not allowed to look
 * like an alarm.
 *
 * ## The scheme
 *
 * A warm-neutral concrete floor under cool slate buildings. The two are separated in *temperature*
 * rather than in value, because a grey building on a grey floor at a shallow isometric angle reads
 * as one continuous surface — which is exactly how the first pass looked. The project block is the
 * darkest and most massive thing on the floor (it is headquarters), the workshops are mid-value with
 * a per-room accent band, and the belts are the darkest small detail so the packages on them stay
 * the most readable moving thing on screen.
 */

/**
 * The status traffic light plus a quiet default, which is what a factory operator already knows how
 * to read at a glance and across a room:
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

/**
 * Selection. Not a status and not an accent: a saturated cyan that appears nowhere else, carried by
 * *added* geometry (a rim, a ground ring, a label border) rather than by repainting the building —
 * a selected room must keep its own identity, or selecting it destroys the information you selected
 * it to read.
 */
export const SELECT_COLOR = "#19d3f5";

// ---- the shell ---------------------------------------------------------------------------------

/** Poured concrete, warm-neutral: the floor slab, its joints and the painted markings on it. */
export const FLOOR = {
  slab: "#c6bfb2",
  /** The lip of the slab, seen wherever it is edge-on. */
  slabEdge: "#a79e8f",
  /** Grid joints in the pour. Barely there on purpose — the belts must stay louder than the floor. */
  joint: "#b0a89a",
  section: "#9d9486",
  /** Painted lane and zone markings: bone white, never safety yellow — yellow is `blocked`. */
  paint: "#e7e1d3",
  /** Outside the slab: cooler and darker, so the slab reads as a building and not as the world. */
  ground: "#8e9298",
  /** The kerb around the slab, and the steel stanchions standing on it. */
  kerb: "#a2998b",
  kerbTop: "#7b7468",
  stanchion: "#8b93a0",
} as const;

/**
 * The lighting rig's colours. Here rather than in the rig itself for the same reason as everything
 * else: the warm/cool split is a decision about how the whole floor looks, not a parameter of one
 * `<directionalLight>`.
 */
export const LIGHT = {
  /** The key: warm, as if through a north-facing sawtooth roof on a bright day. */
  key: "#fff0d6",
  /** The fill: cool, so a shaded face is a *different colour* and not merely darker. */
  fill: "#a9bdd8",
  /** Hemisphere sky. */
  sky: "#ffeedd",
  /** Hemisphere ground: bounce off a big pale concrete slab is the colour of the slab. */
  bounce: "#b5ad9d",
  /** Behind everything, where no geometry reaches. */
  backdrop: "#9aa1a8",
} as const;

// ---- buildings ---------------------------------------------------------------------------------

/**
 * The project block: headquarters. Darkest walls on the floor, and a roof that is deliberately much
 * *lighter* than they are — the first pass gave it a shallow cone in almost the same value as the
 * walls, so from the fixed camera angle it read as a flat dark cap rather than as a pitched roof.
 */
export const PROJECT = {
  wall: "#39424e",
  /** A darker band at the base, so the mass sits on the ground instead of floating on it. */
  plinth: "#2b323b",
  roof: "#4b5563",
  /** The eaves band and the finial, lighter again, to catch the key light. */
  ridge: "#78838f",
} as const;

/** A workshop's shared shell. Its *accent* is what tells one workshop from another. */
export const ROOM = {
  wall: "#8c96a3",
  plinth: "#525c68",
  roof: "#616b77",
  /** The overhanging lip of the flat roof. */
  fascia: "#4c555f",
} as const;

/** Shared building detail, for the project block and the workshops alike. */
export const DETAIL = {
  /** The recessed opening where a belt meets a wall. Nearly black: it has to read as a hole. */
  bay: "#252a31",
  /** The frame around that opening. */
  bayFrame: "#9aa2ab",
  /** Glazing. Dark, because a window is a hole with glass in it. */
  window: "#27303a",
  /**
   * The lights are on inside. Kept *very* faint on purpose: warm glass is the scene's only warm
   * accent on a building, and any brighter it starts reading as the amber that means `blocked`.
   */
  windowGlow: "#ffd7a0",
  /** How hard that glow burns. Tuned down from 0.28, where the strips read as amber bars. */
  windowGlowIntensity: 0.09,
  vent: "#8d949c",
  /** Roof glazing, pale so it reads as sky rather than as a panel. */
  skylight: "#cfe0ea",
} as const;

/** The package meshes travelling the belts, and the belts themselves. */
export const BELT_COLOR = "#3f454b";
export const SLAT_COLOR = "#6d757d";

/**
 * Cardboard, in four tones. A stream of identical cubes reads as a repeating texture rather than as
 * goods, so the boxes vary — but **only** in tone and size, and never by meaning: which kind of
 * message a package carries is M3's to say, and encoding it here would be a colour vocabulary
 * nobody could read yet.
 */
export const PACKAGE_COLORS = ["#c58a4a", "#b87d42", "#d09a5c", "#a97239"] as const;
/** Legacy single-colour export, still the mean of the four. */
export const PACKAGE_COLOR = PACKAGE_COLORS[0];

// ---- per-room accents --------------------------------------------------------------------------

/**
 * The hues the status colours occupy, in degrees. An accent inside any of these bands would compete
 * with a semantic, so the accent range is defined as everything that is left.
 */
export const STATUS_HUE_BANDS: readonly (readonly [number, number])[] = [
  [340, 60],  // red through amber, wrapping past 0
  [90, 165],  // green
  [318, 340], // the bypass magenta
];

/**
 * Where accents are allowed to live: teal, through blue, to violet. 145° of range is enough to tell
 * six workshops apart and it contains no status hue.
 */
export const ACCENT_HUE_MIN = 170;
export const ACCENT_HUE_MAX = 315;
/** Kept well under the status colours' saturation, so an accent can never be mistaken for one. */
const ACCENT_SATURATION = 0.3;

/** A small, stable hash of a room's name. Deterministic across machines and reloads. */
function hashName(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

/**
 * A workshop's own hue, derived from its name so it is stable: the same department is the same colour
 * on every machine and after every reload, with nothing to persist. The hash is spread across the
 * allowed band by the golden ratio, which keeps two similar names from landing on similar hues.
 */
export function roomAccentHue(name: string): number {
  const span = ACCENT_HUE_MAX - ACCENT_HUE_MIN;
  const t = (hashName(name) + 0.6180339887) % 1;
  return Math.round((ACCENT_HUE_MIN + t * span) * 10) / 10;
}

/** `hsl` to `#rrggbb`. Here rather than in a component: colours are data, not markup. */
export function hsl(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  const table: [number, number, number][] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r, g, b] = table[Math.floor(h / 60) % 6];
  const byte = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/**
 * A workshop's accent, in three values: the painted band around its walls, a darker version for its
 * roof fascia, and a lighter one for the frame of its loading bay. Applied as *trim* rather than as
 * the whole wall — six saturated buildings would be a toy, and six tinted-grey buildings with a
 * painted band each is a factory whose departments you can tell apart at a glance.
 */
export function roomAccent(name: string): { band: string; deep: string; light: string } {
  const hue = roomAccentHue(name);
  return {
    band: hsl(hue, ACCENT_SATURATION, 0.52),
    deep: hsl(hue, ACCENT_SATURATION, 0.34),
    light: hsl(hue, ACCENT_SATURATION * 0.8, 0.7),
  };
}
