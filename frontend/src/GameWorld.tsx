/**
 * MMBN-inspired game world on HTML5 Canvas.
 * Tilemap room + sprite-sheet slime creature + plasma substrate background.
 */

import { useRef, useEffect, useImperativeHandle, forwardRef, useState } from "react";
import { COLS, ROWS, TILE, SPRITE_FRAME, PALETTE, ASSETS, SLIME_TINTS } from "./world";
import { loadImage, drawSprite, tickAnimation, getCurrentFrame, setAnimation, gridFrames } from "./sprites";
import type { AnimationState, AnimationDef } from "./sprites";
import { FLOOR_MAP, OBJECT_MAP, drawTileLayer, getObjectInstances, drawSingleTile } from "./tilemap";

const W = COLS * TILE; // 384
const H = ROWS * TILE; // 384

interface Activity {
  type: string;
  detail: string;
}

interface Props {
  position: { x: number; y: number };
  state: string;
  alert: boolean;
  activity: Activity;
  conversing: boolean;
}

// ════════════════════════════════════════════════
// Plasma background — low-res sine interference
// ════════════════════════════════════════════════

const PLASMA_W = 48;
const PLASMA_H = 48;
const SIN_N = 1024;
const SIN_TAB = new Float32Array(SIN_N);
for (let i = 0; i < SIN_N; i++) SIN_TAB[i] = Math.sin((i / SIN_N) * Math.PI * 2);

function fsin(x: number): number {
  const i = ((x * SIN_N / (Math.PI * 2)) % SIN_N + SIN_N) % SIN_N;
  return SIN_TAB[i | 0];
}

type PaletteArr = Uint8Array;

function lerpColor(
  r0: number, g0: number, b0: number,
  r1: number, g1: number, b1: number,
  t: number,
): [number, number, number] {
  return [
    r0 + (r1 - r0) * t,
    g0 + (g1 - g0) * t,
    b0 + (b1 - b0) * t,
  ];
}

function buildPalette(stops: Array<{ pos: number; r: number; g: number; b: number }>): PaletteArr {
  const pal = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (i >= stops[s].pos && i <= stops[s + 1].pos) {
        lo = stops[s];
        hi = stops[s + 1];
        break;
      }
    }
    const t = hi.pos === lo.pos ? 0 : (i - lo.pos) / (hi.pos - lo.pos);
    const [r, g, b] = lerpColor(lo.r, lo.g, lo.b, hi.r, hi.g, hi.b, t);
    pal[i * 3] = r;
    pal[i * 3 + 1] = g;
    pal[i * 3 + 2] = b;
  }
  return pal;
}

const PALETTES: Record<string, PaletteArr> = {
  default: buildPalette([
    { pos: 0,   r: 6,   g: 8,   b: 14  },
    { pos: 55,  r: 0,   g: 30,  b: 25  },
    { pos: 115, r: 0,   g: 100, b: 70  },
    { pos: 155, r: 0,   g: 140, b: 100 },
    { pos: 185, r: 0,   g: 110, b: 140 },
    { pos: 220, r: 0,   g: 50,  b: 40  },
    { pos: 255, r: 6,   g: 8,   b: 14  },
  ]),
  reflecting: buildPalette([
    { pos: 0,   r: 8,   g: 6,   b: 18  },
    { pos: 65,  r: 35,  g: 18,  b: 75  },
    { pos: 130, r: 75,  g: 50,  b: 130 },
    { pos: 175, r: 110, g: 85,  b: 165 },
    { pos: 215, r: 50,  g: 30,  b: 95  },
    { pos: 255, r: 8,   g: 6,   b: 18  },
  ]),
  planning: buildPalette([
    { pos: 0,   r: 6,   g: 10,  b: 8   },
    { pos: 60,  r: 4,   g: 50,  b: 38  },
    { pos: 135, r: 30,  g: 130, b: 95  },
    { pos: 180, r: 55,  g: 145, b: 110 },
    { pos: 225, r: 12,  g: 65,  b: 48  },
    { pos: 255, r: 6,   g: 10,  b: 8   },
  ]),
};

let _plasmaCanvas: HTMLCanvasElement | null = null;
let _plasmaCtx: CanvasRenderingContext2D | null = null;
let _plasmaImageData: ImageData | null = null;

function getPlasmaBuffer(): [HTMLCanvasElement, CanvasRenderingContext2D, ImageData] {
  if (!_plasmaCanvas) {
    _plasmaCanvas = document.createElement("canvas");
    _plasmaCanvas.width = PLASMA_W;
    _plasmaCanvas.height = PLASMA_H;
    _plasmaCtx = _plasmaCanvas.getContext("2d")!;
    _plasmaImageData = _plasmaCtx.createImageData(PLASMA_W, PLASMA_H);
  }
  return [_plasmaCanvas, _plasmaCtx!, _plasmaImageData!];
}

const _distTable = new Float32Array(PLASMA_W * PLASMA_H);
{
  const hw = PLASMA_W / 2, hh = PLASMA_H / 2;
  for (let y = 0; y < PLASMA_H; y++) {
    for (let x = 0; x < PLASMA_W; x++) {
      _distTable[y * PLASMA_W + x] = Math.sqrt((x - hw) ** 2 + (y - hh) ** 2);
    }
  }
}

function renderPlasma(t: number, pal: PaletteArr, brightness: number, speed: number): void {
  const [, plasmaCtx, imageData] = getPlasmaBuffer();
  const data = imageData.data;
  const ts = t * speed;

  for (let y = 0; y < PLASMA_H; y++) {
    for (let x = 0; x < PLASMA_W; x++) {
      const v1 = fsin(x * 0.14 + ts * 0.0008);
      const v2 = fsin(y * 0.11 + ts * 0.0011);
      const v3 = fsin((x + y) * 0.077 + ts * 0.0014);
      const v4 = fsin(_distTable[y * PLASMA_W + x] * 0.18 - ts * 0.0006);
      const v5 = fsin((x - y) * 0.05 + ts * 0.0003);

      const raw = (v1 + v2 + v3 + v4 + v5 + 5) / 10;
      const idx = Math.floor(raw * 255 * brightness) & 0xff;

      const pi = (y * PLASMA_W + x) * 4;
      data[pi] = pal[idx * 3];
      data[pi + 1] = pal[idx * 3 + 1];
      data[pi + 2] = pal[idx * 3 + 2];
      data[pi + 3] = 255;
    }
  }

  plasmaCtx.putImageData(imageData, 0, 0);
}

function drawPlasmaBackground(ctx: CanvasRenderingContext2D, t: number, creatureState: string) {
  const [plasmaCanvas] = getPlasmaBuffer();

  let palKey = "default";
  let brightness = 0.3;
  let speed = 0.8;

  if (creatureState === "thinking") {
    brightness = 0.55;
    speed = 1.4;
  } else if (creatureState === "reflecting") {
    palKey = "reflecting";
    brightness = 0.4;
    speed = 0.5;
  } else if (creatureState === "planning") {
    palKey = "planning";
    brightness = 0.4;
    speed = 1.0;
  }

  renderPlasma(t, PALETTES[palKey], brightness, speed);

  const was = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(plasmaCanvas, 0, 0, W, H);
  ctx.imageSmoothingEnabled = was;
}


// ════════════════════════════════════════════════
// Slime sprite animation definitions
// ════════════════════════════════════════════════

const F = SPRITE_FRAME;

const SLIME_ANIMS: Record<string, AnimationDef> = {
  idle:      { frames: gridFrames(0, 0, 4, F, F), frameDuration: 250, loop: true },
  walk_down: { frames: gridFrames(0, 1, 4, F, F), frameDuration: 150, loop: true },
  walk_up:   { frames: gridFrames(0, 2, 4, F, F), frameDuration: 150, loop: true },
  walk_side: { frames: gridFrames(0, 3, 4, F, F), frameDuration: 150, loop: true },
  think:     { frames: gridFrames(0, 4, 4, F, F), frameDuration: 300, loop: true },
  reflect:   { frames: gridFrames(0, 5, 4, F, F), frameDuration: 350, loop: true },
  plan:      { frames: gridFrames(0, 6, 4, F, F), frameDuration: 300, loop: true },
  sleep:     { frames: gridFrames(0, 7, 2, F, F), frameDuration: 800, loop: true },
  converse:  { frames: gridFrames(0, 8, 4, F, F), frameDuration: 200, loop: true },
};


// ════════════════════════════════════════════════
// State indicators (drawn at full resolution)
// ════════════════════════════════════════════════

function drawThinkingBubble(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(x, y - 6, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#888";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#666";
  ctx.font = "9px monospace";
  ctx.textAlign = "center";
  ctx.fillText("...", x, y - 3);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(x + 5, y + 3, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + 3, y + 6, 1.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawReflectionSparkle(ctx: CanvasRenderingContext2D, x: number, y: number, t: number) {
  const phase = t / 200;
  ctx.fillStyle = "#c084fc";
  for (let i = 0; i < 4; i++) {
    const angle = (Math.PI / 2) * i + phase;
    const sx = x + Math.cos(angle) * 6;
    const sy = y - 6 + Math.sin(angle) * 6;
    ctx.beginPath();
    ctx.arc(sx, sy, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#a855f7";
  ctx.beginPath();
  ctx.arc(x, y - 6, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlanningClipboard(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const padX = x - 5;
  const padY = y - 16;
  ctx.fillStyle = "#14b8a6";
  ctx.fillRect(padX, padY, 10, 12);
  ctx.fillStyle = "#0d9488";
  ctx.fillRect(padX + 1, padY - 2, 8, 3);
  ctx.fillStyle = "#fff";
  ctx.fillRect(padX + 2, padY + 3, 6, 1);
  ctx.fillRect(padX + 2, padY + 6, 6, 1);
  ctx.fillRect(padX + 2, padY + 9, 4, 1);
}

function drawConversingBubble(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const bx = x - 8;
  const by = y - 20;
  ctx.fillStyle = "#ea580c";
  ctx.beginPath();
  ctx.roundRect(bx - 4, by - 4, 24, 14, 4);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(bx + 2, by + 10);
  ctx.lineTo(bx + 6, by + 15);
  ctx.lineTo(bx + 10, by + 10);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(bx + 4, by + 3, 2, 0, Math.PI * 2);
  ctx.arc(bx + 10, by + 3, 2, 0, Math.PI * 2);
  ctx.arc(bx + 16, by + 3, 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawAlertBubble(ctx: CanvasRenderingContext2D, x: number, y: number, t: number) {
  const bounce = Math.sin(t / 300) * 3;
  const alertY = y - 14 + bounce;
  ctx.fillStyle = "#ef4444";
  ctx.beginPath();
  ctx.arc(x, alertY, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("!", x, alertY);
}

function drawComputing(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(x - 12, y - 8, 24, 16);
  ctx.strokeStyle = "#8b5cf6";
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 12, y - 8, 24, 16);
  ctx.fillStyle = "#a78bfa";
  ctx.font = "bold 9px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const blink = Math.floor(Date.now() / 600) % 3;
  const symbols = ["(λ)", "(· )", "( ·)"];
  ctx.fillText(symbols[blink], x, y);
}


// ════════════════════════════════════════════════
// Component
// ════════════════════════════════════════════════

export interface GameWorldHandle {
  snapshot: () => string;
}

const GameWorld = forwardRef<GameWorldHandle, Props>(
  ({ position, state, alert, activity, conversing }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const posRef = useRef({ x: position.x, y: position.y });
    const targetRef = useRef({ x: position.x, y: position.y });
    const stateRef = useRef(state);
    const alertRef = useRef(alert);
    const activityRef = useRef(activity);
    const conversingRef = useRef(conversing);

    const animStateRef = useRef<AnimationState>({
      currentAnim: "idle",
      frameIndex: 0,
      lastFrameTime: 0,
    });

    const [assetsReady, setAssetsReady] = useState(false);
    const tilesetRef = useRef<HTMLImageElement | null>(null);
    const slimeSheetRef = useRef<HTMLImageElement | null>(null);

    // Pre-compute object instances for y-sorting
    const objectsRef = useRef(getObjectInstances(OBJECT_MAP));

    useImperativeHandle(ref, () => ({
      snapshot: () => canvasRef.current?.toDataURL() || "",
    }));

    useEffect(() => { targetRef.current = { x: position.x, y: position.y }; }, [position.x, position.y]);
    useEffect(() => { stateRef.current = state; }, [state]);
    useEffect(() => { alertRef.current = alert; }, [alert]);
    useEffect(() => { activityRef.current = activity; }, [activity]);
    useEffect(() => { conversingRef.current = conversing; }, [conversing]);

    // Load sprite assets
    useEffect(() => {
      Promise.all([
        loadImage(ASSETS.tileset),
        loadImage(ASSETS.slimeSheet),
      ]).then(([tileset, slimeSheet]) => {
        tilesetRef.current = tileset;
        slimeSheetRef.current = slimeSheet;
        setAssetsReady(true);
      }).catch((err) => {
        console.error("Failed to load sprite assets:", err);
      });
    }, []);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      let animId: number;
      let running = true;

      const render = () => {
        if (!running) return;
        const t = Date.now();
        const pos = posRef.current;
        const target = targetRef.current;
        const dx = target.x - pos.x;
        const dy = target.y - pos.y;
        const moving = Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02;

        if (moving) {
          pos.x += dx * 0.1;
          pos.y += dy * 0.1;
        } else {
          pos.x = target.x;
          pos.y = target.y;
        }

        const creatureState = stateRef.current;

        // ── Layer 0: Plasma background ──
        drawPlasmaBackground(ctx, t, creatureState);

        // ── Layer 1: Tilemap floor ──
        if (tilesetRef.current) {
          // Draw floor with slight transparency so plasma shows through
          ctx.globalAlpha = 0.85;
          drawTileLayer(ctx, tilesetRef.current, FLOOR_MAP, t);
          ctx.globalAlpha = 1;
        }

        // ── Layer 2: Grid overlay ──
        ctx.strokeStyle = "rgba(0, 229, 160, 0.06)";
        ctx.lineWidth = 0.5;
        for (let x = 0; x <= COLS; x++) {
          ctx.beginPath();
          ctx.moveTo(x * TILE, 0);
          ctx.lineTo(x * TILE, H);
          ctx.stroke();
        }
        for (let y = 0; y <= ROWS; y++) {
          ctx.beginPath();
          ctx.moveTo(0, y * TILE);
          ctx.lineTo(W, y * TILE);
          ctx.stroke();
        }

        // ── Layer 3: Objects behind creature (y > creature row) + creature + objects in front ──
        const creatureRow = Math.round(pos.y);
        const objects = objectsRef.current;

        // Draw objects behind creature
        if (tilesetRef.current) {
          for (const obj of objects) {
            if (obj.row < creatureRow) {
              drawSingleTile(ctx, tilesetRef.current, obj, t);
            }
          }
        }

        // ── Creature sprite ──
        const charX = pos.x * TILE + TILE / 2;
        const charY = pos.y * TILE + TILE / 2;

        if (slimeSheetRef.current) {
          // Determine target animation
          let targetAnim = "idle";
          if (moving) {
            if (Math.abs(dx) > Math.abs(dy)) {
              targetAnim = "walk_side";
            } else {
              targetAnim = dy > 0 ? "walk_down" : "walk_up";
            }
          } else if (conversingRef.current) {
            targetAnim = "converse";
          } else if (creatureState === "reflecting") {
            targetAnim = "reflect";
          } else if (creatureState === "planning") {
            targetAnim = "plan";
          } else if (creatureState === "thinking") {
            targetAnim = "think";
          }

          // Update animation state
          animStateRef.current = setAnimation(animStateRef.current, targetAnim, t);
          const anim = SLIME_ANIMS[animStateRef.current.currentAnim];
          if (anim) {
            animStateRef.current = tickAnimation(animStateRef.current, anim, t);
            const frame = getCurrentFrame(animStateRef.current, anim);

            // Determine tint
            const tintDef = SLIME_TINTS[creatureState];

            drawSprite(ctx, slimeSheetRef.current, frame, charX, charY + 4, {
              flipX: moving && dx < 0 && targetAnim === "walk_side",
              tint: tintDef?.color,
              tintAmount: tintDef?.amount,
            });
          }
        }

        // Draw objects in front of creature
        if (tilesetRef.current) {
          for (const obj of objects) {
            if (obj.row >= creatureRow) {
              drawSingleTile(ctx, tilesetRef.current, obj, t);
            }
          }
        }

        // ── State indicators ──
        const indicatorX = charX;
        const indicatorY = charY - SPRITE_FRAME / 2 - 4;

        if (creatureState === "thinking") drawThinkingBubble(ctx, indicatorX, indicatorY);
        else if (creatureState === "reflecting") drawReflectionSparkle(ctx, indicatorX, indicatorY, t);
        else if (creatureState === "planning") drawPlanningClipboard(ctx, indicatorX, indicatorY);

        if (conversingRef.current) drawConversingBubble(ctx, indicatorX, indicatorY);
        if (alertRef.current) drawAlertBubble(ctx, indicatorX, indicatorY, t);

        // Activity indicator to the right
        const act = activityRef.current;
        if (act.type !== "idle" && act.type !== "moving") {
          const actX = charX + SPRITE_FRAME / 2 + 8;
          const actY = charY;
          if (act.type === "computing") {
            drawComputing(ctx, actX, actY);
          } else if (act.type === "conversing") {
            ctx.strokeStyle = "#ea580c";
            ctx.lineWidth = 2;
            for (let i = 0; i < 3; i++) {
              const ly = actY - 4 + i * 4;
              ctx.beginPath();
              ctx.moveTo(actX - 6, ly);
              ctx.lineTo(actX + 6 - i * 2, ly);
              ctx.stroke();
            }
          }
        }

        // ── Scanlines ──
        ctx.fillStyle = "rgba(0, 0, 0, 0.04)";
        for (let y = 0; y < H; y += 2) {
          ctx.fillRect(0, y, W, 1);
        }

        // ── Vignette ──
        const vg = ctx.createRadialGradient(W / 2, H / 2, W * 0.25, W / 2, H / 2, W * 0.65);
        vg.addColorStop(0, "transparent");
        vg.addColorStop(1, "rgba(4, 6, 10, 0.55)");
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, W, H);

        // ── Activity detail text — bottom bar ──
        if (act.type !== "idle" && act.detail) {
          const label = act.detail.length > 40
            ? act.detail.slice(0, 40) + "..."
            : act.detail;
          ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
          ctx.fillRect(0, H - 22, W, 22);
          ctx.fillStyle = "#e2e8f0";
          ctx.font = "10px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, W / 2, H - 11);
        }

        animId = requestAnimationFrame(render);
      };

      animId = requestAnimationFrame(render);

      return () => {
        running = false;
        cancelAnimationFrame(animId);
      };
    }, [assetsReady]);

    return (
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{
          width: "100%",
          maxWidth: W * 2,
          imageRendering: "pixelated",
          borderRadius: 4,
          border: "2px solid #1a4a7a",
          boxShadow: "0 0 12px rgba(0, 100, 255, 0.25), inset 0 0 8px rgba(0, 100, 255, 0.08)",
        }}
      />
    );
  },
);

export default GameWorld;
