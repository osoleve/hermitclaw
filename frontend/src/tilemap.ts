/**
 * Tilemap data and renderer for the MMBN-inspired cyber room.
 * Aligned with the collision map in brain.py.
 */

import { COLS, ROWS, TILE } from "./world";

// --- Types ---

export interface TileDef {
  x: number; // pixel x in tileset
  y: number; // pixel y in tileset
  w?: number; // defaults to TILE
  h?: number; // defaults to TILE
  animated?: {
    frameCount: number;
    frameDuration: number; // ms per frame
    // Frames are laid out horizontally in the tileset
  };
}

// --- Tile definitions ---
// Each ID maps to a region in room-tileset.png
// The tileset is laid out as a grid of 32x32 tiles

export const TILE_DEFS: Record<number, TileDef> = {
  // 0 = empty (no draw)

  // Floor tiles (row 0 of tileset)
  1: { x: 0, y: 0 },                                                    // floor base (dark panel)
  2: { x: 32, y: 0 },                                                   // floor variant (subtle difference)
  3: { x: 64, y: 0, animated: { frameCount: 3, frameDuration: 600 } },  // floor glow (animated pulse)

  // Wall tiles (row 1 of tileset)
  10: { x: 0, y: 32 },   // wall top
  11: { x: 32, y: 32 },  // wall top-left corner
  12: { x: 64, y: 32 },  // wall top-right corner
  13: { x: 96, y: 32 },  // wall left
  14: { x: 128, y: 32 }, // wall right
  15: { x: 160, y: 32 }, // wall bottom-left
  16: { x: 192, y: 32 }, // wall bottom-right

  // Furniture tiles (row 2+ of tileset)
  20: { x: 0, y: 64 },   // desk / terminal
  21: { x: 32, y: 64 },  // bookshelf / data rack
  22: { x: 64, y: 64 },  // window / viewport
  23: { x: 96, y: 64 },  // plant / digital growth
  24: { x: 128, y: 64 }, // bed / rest pod
  25: { x: 160, y: 64, animated: { frameCount: 2, frameDuration: 800 } }, // nexus pad (animated glow)

  // Decorative blocked tiles (row 3)
  30: { x: 0, y: 96 },   // tech panel (generic blocked tile)
  31: { x: 32, y: 96 },  // server unit
  32: { x: 64, y: 96 },  // cable conduit
};

// --- Room layout ---
// Must align with collision_rows in brain.py:
//   Row 0:  XXXX..XXXXXX
//   Row 1:  ..XX...XX...
//   Row 2:  .......XXXX.
//   Row 3:  ..XX...XX...
//   Row 4:  ..XX...XX...
//   Row 5:  ........XX..
//   Row 6:  ............
//   Row 7:  ..XXXXXX..XX
//   Row 8:  ..XX...X..X.
//   Row 9:  ....XXX...X.
//   Row 10: XX...X.....X
//   Row 11: X....X......

// Floor layer — drawn first. Walls and base floor.
// 0 = skip (void), 1/2 = floor variants, 3 = animated floor, 10+ = walls
export const FLOOR_MAP: number[][] = [
  [10, 10, 10, 10,  1,  1, 10, 10, 10, 10, 10, 10],  // row 0: top wall, gap at 4-5 (window area)
  [ 1,  1, 10, 10,  1,  2,  1, 10, 10,  1,  1,  2],  // row 1: floor + wall pillars
  [ 1,  2,  1,  1,  1,  1,  1, 10, 10, 10, 10,  1],  // row 2: floor + right wall block
  [ 1,  1, 10, 10,  1,  1,  1, 10, 10,  2,  1,  1],  // row 3
  [ 2,  1, 10, 10,  1,  2,  1, 10, 10,  1,  1,  2],  // row 4
  [ 1,  1,  1,  2,  1,  3,  1,  1, 10, 10,  1,  1],  // row 5: nexus center has glow floor
  [ 1,  2,  1,  1,  2,  1,  1,  2,  1,  1,  2,  1],  // row 6: all open
  [ 1,  1, 10, 10, 10, 10, 10, 10,  1,  1, 10, 10],  // row 7: large wall block
  [ 2,  1, 10, 10,  1,  1,  1, 10,  1,  1, 10,  1],  // row 8
  [ 1,  1,  1,  1, 10, 10, 10,  1,  2,  1, 10,  1],  // row 9
  [10, 10,  1,  1,  1, 10,  2,  1,  1,  1,  1, 10],  // row 10
  [10,  1,  1,  2,  1, 10,  1,  1,  2,  1,  1,  1],  // row 11
];

// Object layer — furniture and decorations drawn on top of floor.
// 0 = empty (no object)
export const OBJECT_MAP: number[][] = [
  [ 0,  0,  0,  0, 22,  0,  0,  0,  0,  0,  0,  0],  // row 0: window at (4,0)
  [ 0,  0,  0,  0,  0,  0,  0,  0,  0,  0, 20,  0],  // row 1: desk at (10,1)
  [ 0, 21,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0],  // row 2: bookshelf at (1,2)
  [ 0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0],  // row 3
  [ 0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0],  // row 4
  [ 0,  0,  0,  0,  0, 25,  0,  0,  0,  0,  0,  0],  // row 5: nexus pad at (5,5)
  [ 0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0],  // row 6
  [ 0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0],  // row 7
  [23,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0],  // row 8: plant at (0,8)
  [ 0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0],  // row 9
  [ 0,  0,  0, 24,  0,  0,  0,  0,  0,  0,  0,  0],  // row 10: bed at (3,10)
  [ 0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0],  // row 11
];

// --- Renderer ---

export function drawTileLayer(
  ctx: CanvasRenderingContext2D,
  tileset: HTMLImageElement,
  layer: number[][],
  t: number,
): void {
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const tileId = layer[row]?.[col];
      if (!tileId) continue; // 0 or undefined = skip

      const def = TILE_DEFS[tileId];
      if (!def) continue;

      const tw = def.w ?? TILE;
      const th = def.h ?? TILE;
      const destX = col * TILE;
      const destY = row * TILE;

      let srcX = def.x;
      const srcY = def.y;

      // Handle animated tiles
      if (def.animated) {
        const frameIdx = Math.floor(t / def.animated.frameDuration) % def.animated.frameCount;
        srcX = def.x + frameIdx * tw;
      }

      ctx.drawImage(tileset, srcX, srcY, tw, th, destX, destY, TILE, TILE);
    }
  }
}

// --- Y-sorted object drawing (for depth) ---

export interface ObjectInstance {
  col: number;
  row: number;
  tileId: number;
}

export function getObjectInstances(layer: number[][]): ObjectInstance[] {
  const objects: ObjectInstance[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const tileId = layer[row]?.[col];
      if (tileId) {
        objects.push({ col, row, tileId });
      }
    }
  }
  return objects;
}

export function drawSingleTile(
  ctx: CanvasRenderingContext2D,
  tileset: HTMLImageElement,
  obj: ObjectInstance,
  t: number,
): void {
  const def = TILE_DEFS[obj.tileId];
  if (!def) return;

  const tw = def.w ?? TILE;
  const th = def.h ?? TILE;
  const destX = obj.col * TILE;
  const destY = obj.row * TILE;

  let srcX = def.x;
  if (def.animated) {
    const frameIdx = Math.floor(t / def.animated.frameDuration) % def.animated.frameCount;
    srcX = def.x + frameIdx * tw;
  }

  ctx.drawImage(tileset, srcX, def.y, tw, th, destX, destY, TILE, TILE);
}
