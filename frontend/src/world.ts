/**
 * World configuration — MMBN-inspired pixel-art room with slime creature.
 */

// Room grid dimensions
export const COLS = 12;
export const ROWS = 12;
export const TILE = 32; // pixels per tile

// Sprite sheet frame size
export const SPRITE_FRAME = 48; // native frame size in sprite sheet

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

// Asset paths — served from public/assets/
export const ASSETS = {
  tileset: "/assets/tiles/room-tileset.png",
  slimeSheet: "/assets/sprites/slime-sheet.png",
} as const;

// Slime state tint colors (applied over base sprite)
export const SLIME_TINTS: Record<string, { color: string; amount: number }> = {
  reflecting: { color: "#a78bfa", amount: 0.35 },
  planning:   { color: "#34d399", amount: 0.3 },
};
