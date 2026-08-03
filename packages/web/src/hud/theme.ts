/**
 * The 2D overlay's colour vocabulary. Deliberately separate from `scene/palette.ts`: that table is
 * about *status* and is shared by the beacons and the figures, this one is about the chrome of the
 * HUD (text, rules, dim labels). A panel that invented its own greys would stop reading as the same
 * surface as the console drawer, which is the one thing the overlay has to get right while it waits
 * for a real design pass.
 */
export const HUD = {
  dim: "#7a7a7a",
  text: "#1c1c1c",
  err: "#c0392b",
  line: "#d8d8d8",
  card: "#e08a00",
  /** The panels themselves: a near-opaque wash so the floor stays faintly visible behind them. */
  panel: "rgba(250,250,250,0.94)",
} as const;
