/**
 * World configuration — pixel-art room with slime creature.
 */

// Room grid dimensions (matches room.png)
export const COLS = 12;
export const ROWS = 12;
export const TILE = 32; // pixels per tile

// Pixel slime rendering
export const SPRITE_SIZE = 16;  // native pixel art resolution
export const DISPLAY_SIZE = 48; // rendered size on canvas (3x scale)

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

// Palette — bioluminescent computation (shared with App.tsx)
export const PALETTE = {
  void:        "#080c14",
  surface:     "#0f1520",
  border:      "#1a2535",
  glow:        "#00e5a0",
  glowCyan:    "#00c8ff",
  computation: "#f0b040",
  dream:       "#a78bfa",
  plan:        "#34d399",
  respond:     "#f97316",
  owner:       "#60a5fa",
  error:       "#f87171",
  text:        "#c8d6e5",
  dim:         "#5a6a7a",
} as const;

// Slime body colors by state
export const SLIME_COLORS: Record<string, { body: string; light: string; dark: string }> = {
  default:    { body: "#00e5a0", light: "#66ffd0", dark: "#009968" },
  reflecting: { body: "#a78bfa", light: "#c4b5fd", dark: "#7c5cc5" },
  planning:   { body: "#34d399", light: "#6ee7b7", dark: "#059669" },
};
