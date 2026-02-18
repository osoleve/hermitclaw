/**
 * World configuration for Myxo — the Fold substrate room and slime creature.
 * Replaces the old sprite-sheet-based sprites.ts.
 */

// Room grid dimensions
export const COLS = 12;
export const ROWS = 12;
export const TILE = 32; // pixels per tile

// Named locations (tile coordinates within 12x12 room)
export const LOCATIONS: Record<string, { x: number; y: number; label: string }> = {
  desk:      { x: 10, y: 1,  label: "desk" },
  bookshelf: { x: 1,  y: 2,  label: "shelf" },
  window:    { x: 4,  y: 0,  label: "window" },
  plant:     { x: 0,  y: 8,  label: "growth" },
  bed:       { x: 3,  y: 10, label: "rest" },
  rug:       { x: 5,  y: 5,  label: "nexus" },
  center:    { x: 5,  y: 5,  label: "nexus" },
};

// Palette — bioluminescent computation
export const PALETTE = {
  void:        "#080c14",
  surface:     "#0f1520",
  border:      "#1a2535",
  glow:        "#00e5a0",   // primary teal-green
  glowCyan:    "#00c8ff",   // secondary cyan
  computation: "#f0b040",   // amber — Fold activity
  dream:       "#a78bfa",   // purple — reflection
  plan:        "#34d399",   // emerald — planning
  respond:     "#f97316",   // coral — creature voice
  owner:       "#60a5fa",   // blue — user voice
  error:       "#f87171",   // soft red
  text:        "#c8d6e5",   // cool gray-white
  dim:         "#5a6a7a",   // dim text
} as const;

// Slime creature rendering config
export const SLIME = {
  baseRadius: 18,
  controlPoints: 10,       // perimeter deformation points
  wobbleSpeed: 0.003,      // wobble frequency
  wobbleAmp: 2.5,          // max wobble displacement in px
  breathSpeed: 0.002,      // breathing frequency
  breathAmp: 1.5,          // breathing radius change
  eyeRadius: 2.5,
  eyeOffset: 6,            // distance from center to each eye
  eyeShiftMax: 2,          // max eye shift toward movement direction
  stretchFactor: 1.25,     // elongation in movement direction
  squashFactor: 0.8,       // compression perpendicular to movement
} as const;

// Room grid rendering
export const GRID = {
  lineColor: "rgba(0, 229, 160, 0.06)",
  nodeRadius: 4,
  nodeGlow: "rgba(0, 229, 160, 0.15)",
  nodeLabelColor: "rgba(200, 214, 229, 0.25)",
  particleCount: 20,
  particleMaxRadius: 1.2,
  particleMinAlpha: 0.1,
  particleMaxAlpha: 0.35,
  particleDriftSpeed: 0.15,
} as const;
