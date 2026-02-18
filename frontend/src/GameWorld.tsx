/**
 * Demoscene-flavored game world on HTML5 Canvas.
 * Plasma substrate background + pixel-art slime creature.
 */

import { useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { COLS, ROWS, TILE, SPRITE_SIZE, DISPLAY_SIZE, SLIME_COLORS, LOCATIONS } from "./world";

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
// Pre-compute sine table. 1024 entries covers 2π with <0.4% error
// on linear interpolation, which is invisible at 64x64.
const SIN_N = 1024;
const SIN_TAB = new Float32Array(SIN_N);
for (let i = 0; i < SIN_N; i++) SIN_TAB[i] = Math.sin((i / SIN_N) * Math.PI * 2);

function fsin(x: number): number {
  // Fast sine via table lookup. Handles negative values.
  const i = ((x * SIN_N / (Math.PI * 2)) % SIN_N + SIN_N) % SIN_N;
  return SIN_TAB[i | 0];
}

// Color palette: 256 entries, pre-built per creature state.
// Each palette is a Uint8Array of length 256*3 (r,g,b triples).
type Palette = Uint8Array;

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

function buildPalette(stops: Array<{ pos: number; r: number; g: number; b: number }>): Palette {
  const pal = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    // Find surrounding stops
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

// Palettes keyed by creature state.
// Peaks are kept muted — brightness multiplier in drawBackground scales them further.
const PALETTES: Record<string, Palette> = {
  // Default / idle / thinking: void → deep teal → muted teal → dim cyan → void
  default: buildPalette([
    { pos: 0,   r: 6,   g: 8,   b: 14  },
    { pos: 55,  r: 0,   g: 30,  b: 25  },
    { pos: 115, r: 0,   g: 100, b: 70  },
    { pos: 155, r: 0,   g: 140, b: 100 },
    { pos: 185, r: 0,   g: 110, b: 140 },
    { pos: 220, r: 0,   g: 50,  b: 40  },
    { pos: 255, r: 6,   g: 8,   b: 14  },
  ]),
  // Reflecting: void → deep indigo → violet → soft lavender → void
  reflecting: buildPalette([
    { pos: 0,   r: 8,   g: 6,   b: 18  },
    { pos: 65,  r: 35,  g: 18,  b: 75  },
    { pos: 130, r: 75,  g: 50,  b: 130 },
    { pos: 175, r: 110, g: 85,  b: 165 },
    { pos: 215, r: 50,  g: 30,  b: 95  },
    { pos: 255, r: 8,   g: 6,   b: 18  },
  ]),
  // Planning: void → dark emerald → muted green → dim teal → void
  planning: buildPalette([
    { pos: 0,   r: 6,   g: 10,  b: 8   },
    { pos: 60,  r: 4,   g: 50,  b: 38  },
    { pos: 135, r: 30,  g: 130, b: 95  },
    { pos: 180, r: 55,  g: 145, b: 110 },
    { pos: 225, r: 12,  g: 65,  b: 48  },
    { pos: 255, r: 6,   g: 10,  b: 8   },
  ]),
};

// Pre-allocate plasma offscreen canvas and ImageData
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

// Pre-compute distance-from-center table for radial plasma component
const _distTable = new Float32Array(PLASMA_W * PLASMA_H);
{
  const hw = PLASMA_W / 2, hh = PLASMA_H / 2;
  for (let y = 0; y < PLASMA_H; y++) {
    for (let x = 0; x < PLASMA_W; x++) {
      _distTable[y * PLASMA_W + x] = Math.sqrt((x - hw) ** 2 + (y - hh) ** 2);
    }
  }
}

/**
 * Render plasma at 64x64, write directly to ImageData buffer.
 * Four sine interference waves + radial distortion.
 * `speed` multiplier makes it faster during thinking.
 * `brightness` scales the palette index range (0 = dark, 1 = full).
 */
function renderPlasma(
  t: number,
  pal: Palette,
  brightness: number,
  speed: number,
): void {
  const [plasmaCanvas, plasmaCtx, imageData] = getPlasmaBuffer();
  const data = imageData.data;
  const ts = t * speed;

  for (let y = 0; y < PLASMA_H; y++) {
    for (let x = 0; x < PLASMA_W; x++) {
      const v1 = fsin(x * 0.14 + ts * 0.0008);
      const v2 = fsin(y * 0.11 + ts * 0.0011);
      const v3 = fsin((x + y) * 0.077 + ts * 0.0014);
      const v4 = fsin(_distTable[y * PLASMA_W + x] * 0.18 - ts * 0.0006);
      // Fifth wave: slow diagonal sweep for larger structure
      const v5 = fsin((x - y) * 0.05 + ts * 0.0003);

      // Sum to [-5, 5], normalize to [0, 1]
      const raw = (v1 + v2 + v3 + v4 + v5 + 5) / 10;
      // Apply brightness curve — dims toward edges of palette
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

/**
 * Blit the 64x64 plasma canvas onto the main canvas at full size,
 * then layer effects on top.
 */
function drawBackground(
  ctx: CanvasRenderingContext2D,
  t: number,
  creatureState: string,
) {
  const [plasmaCanvas] = getPlasmaBuffer();

  // Each state gets its own palette, brightness, and speed
  let palKey = "default";
  let brightness = 0.3;
  let speed = 0.8;

  if (creatureState === "thinking") {
    brightness = 0.55;
    speed = 1.4;
  } else if (creatureState === "reflecting") {
    palKey = "reflecting";
    brightness = 0.4;
    speed = 0.5; // slow, dreamy
  } else if (creatureState === "planning") {
    palKey = "planning";
    brightness = 0.4;
    speed = 1.0;
  }

  const pal = PALETTES[palKey];

  renderPlasma(t, pal, brightness, speed);

  // Blit plasma scaled up with nearest-neighbor for chunky pixels
  const was = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(plasmaCanvas, 0, 0, W, H);
  ctx.imageSmoothingEnabled = was;

  // ── Grid overlay ──
  // Subtle lattice lines suggesting computational structure
  ctx.strokeStyle = "rgba(0, 229, 160, 0.08)";
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

  // ── Location nodes ──
  // Glowing spots at named locations
  ctx.font = "8px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const seen = new Set<string>();
  for (const [, loc] of Object.entries(LOCATIONS)) {
    const key = `${loc.x},${loc.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cx = loc.x * TILE + TILE / 2;
    const cy = loc.y * TILE + TILE / 2;
    const pulse = 1 + fsin(t * 0.003 + loc.x * 0.7) * 0.3;
    // Glow halo
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 14 * pulse);
    grad.addColorStop(0, "rgba(0, 229, 160, 0.18)");
    grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, 14 * pulse, 0, Math.PI * 2);
    ctx.fill();
    // Core dot
    ctx.fillStyle = `rgba(0, 229, 160, ${0.2 + pulse * 0.12})`;
    ctx.beginPath();
    ctx.arc(cx, cy, 2 * pulse, 0, Math.PI * 2);
    ctx.fill();
    // Label
    ctx.fillStyle = "rgba(200, 214, 229, 0.3)";
    ctx.fillText(loc.label, cx, cy + 12);
  }

  // ── Scanlines ──
  // Faint horizontal lines for CRT / retro feel
  ctx.fillStyle = "rgba(0, 0, 0, 0.06)";
  for (let y = 0; y < H; y += 2) {
    ctx.fillRect(0, y, W, 1);
  }

  // ── Vignette ──
  // Darken edges to frame the scene
  const vg = ctx.createRadialGradient(W / 2, H / 2, W * 0.2, W / 2, H / 2, W * 0.65);
  vg.addColorStop(0, "transparent");
  vg.addColorStop(1, "rgba(4, 6, 10, 0.7)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}


// ════════════════════════════════════════════════
// Pixel-art slime creature
// ════════════════════════════════════════════════

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// Reusable offscreen canvases — allocated once, reused every frame.
let _slimeCanvas: HTMLCanvasElement | null = null;
let _slimeCtx: CanvasRenderingContext2D | null = null;
let _blitCanvas: HTMLCanvasElement | null = null;
let _blitCtx: CanvasRenderingContext2D | null = null;

function getSlimeCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  if (!_slimeCanvas) {
    _slimeCanvas = document.createElement("canvas");
    _slimeCanvas.width = SPRITE_SIZE;
    _slimeCanvas.height = SPRITE_SIZE;
    _slimeCtx = _slimeCanvas.getContext("2d")!;
  }
  return [_slimeCanvas, _slimeCtx!];
}

function getBlitCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  if (!_blitCanvas) {
    _blitCanvas = document.createElement("canvas");
    _blitCanvas.width = SPRITE_SIZE;
    _blitCanvas.height = SPRITE_SIZE;
    _blitCtx = _blitCanvas.getContext("2d")!;
  }
  return [_blitCanvas, _blitCtx!];
}

function renderSlimeFrame(
  state: string,
  squish: number,
  bobOffset: number,
  eyeShiftX: number,
  eyeShiftY: number,
): ImageData {
  const S = SPRITE_SIZE;
  const [, ctx] = getSlimeCanvas();
  ctx.clearRect(0, 0, S, S);

  const colors = SLIME_COLORS[state] || SLIME_COLORS.default;
  const [br, bg, bb] = hexToRgb(colors.body);
  const [lr, lg, lb] = hexToRgb(colors.light);
  const [dr, dg, db] = hexToRgb(colors.dark);

  const cx = 7.5;
  const baseY = 13 + Math.round(bobOffset);
  const rx = 6 + (squish < 0 ? -squish * 1.5 : -squish * 0.5);
  const ry = 5 + squish * 2;

  // Body pixels
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const ndx = (px - cx) / rx;
      const ndy = (py - (baseY - ry)) / ry;
      if (ndx * ndx + ndy * ndy <= 1 && py <= baseY) {
        const shade = (-ndx * 0.3 - ndy * 0.7 + 0.3);
        let r: number, g: number, b: number;
        if (shade > 0.4) {
          const t = Math.min((shade - 0.4) / 0.6, 1);
          r = br + (lr - br) * t;
          g = bg + (lg - bg) * t;
          b = bb + (lb - bb) * t;
        } else if (shade < -0.1) {
          const t = Math.min((-0.1 - shade) / 0.9, 1);
          r = br + (dr - br) * t;
          g = bg + (dg - bg) * t;
          b = bb + (db - bb) * t;
        } else {
          r = br; g = bg; b = bb;
        }
        ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
        ctx.fillRect(px, py, 1, 1);
      }
    }
  }

  // Specular highlight
  const hlX = Math.round(cx - 3);
  const hlY = Math.round(baseY - ry - 0.5 + 2 + bobOffset);
  ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
  ctx.fillRect(hlX, hlY, 2, 1);
  ctx.fillRect(hlX, hlY + 1, 1, 1);

  // Eyes
  const eyeCenterY = Math.round(baseY - ry * 0.5 + bobOffset);
  const leftEyeX = Math.round(cx - 2.5 + eyeShiftX);
  const rightEyeX = Math.round(cx + 1.5 + eyeShiftX);
  const eyeY = eyeCenterY + Math.round(eyeShiftY);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(leftEyeX, eyeY, 2, 2);
  ctx.fillRect(rightEyeX, eyeY, 2, 2);

  // Pupils
  ctx.fillStyle = "#1a1a2e";
  const pupilOffX = Math.round(eyeShiftX * 0.5);
  const pupilOffY = Math.round(eyeShiftY * 0.5);
  ctx.fillRect(leftEyeX + pupilOffX + (eyeShiftX >= 0 ? 1 : 0), eyeY + pupilOffY + 1, 1, 1);
  ctx.fillRect(rightEyeX + pupilOffX + (eyeShiftX >= 0 ? 1 : 0), eyeY + pupilOffY + 1, 1, 1);

  // Ground shadow
  const shadowY = baseY + 1;
  if (shadowY < S) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
    const shadowW = Math.round(rx * 1.6);
    const shadowX = Math.round(cx - shadowW / 2);
    ctx.fillRect(shadowX, shadowY, shadowW, 1);
    if (shadowY + 1 < S) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
      ctx.fillRect(shadowX + 1, shadowY + 1, shadowW - 2, 1);
    }
  }

  return ctx.getImageData(0, 0, S, S);
}

function blitSlimeFrame(
  mainCtx: CanvasRenderingContext2D,
  frame: ImageData,
  x: number,
  y: number,
) {
  const [blitCanvas, blitCtx] = getBlitCanvas();
  blitCtx.putImageData(frame, 0, 0);
  const was = mainCtx.imageSmoothingEnabled;
  mainCtx.imageSmoothingEnabled = false;
  mainCtx.drawImage(blitCanvas, x, y, DISPLAY_SIZE, DISPLAY_SIZE);
  mainCtx.imageSmoothingEnabled = was;
}


// ════════════════════════════════════════════════
// State indicators (drawn at full resolution, on top of everything)
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

    const movePhaseRef = useRef(0);
    const moveTimerRef = useRef(0);

    useImperativeHandle(ref, () => ({
      snapshot: () => canvasRef.current?.toDataURL() || "",
    }));

    useEffect(() => { targetRef.current = { x: position.x, y: position.y }; }, [position.x, position.y]);
    useEffect(() => { stateRef.current = state; }, [state]);
    useEffect(() => { alertRef.current = alert; }, [alert]);
    useEffect(() => { activityRef.current = activity; }, [activity]);
    useEffect(() => { conversingRef.current = conversing; }, [conversing]);

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
          moveTimerRef.current++;
          if (moveTimerRef.current % 6 === 0) {
            movePhaseRef.current = (movePhaseRef.current + 1) % 4;
          }
        } else {
          pos.x = target.x;
          pos.y = target.y;
          movePhaseRef.current = 0;
          moveTimerRef.current = 0;
        }

        const creatureState = stateRef.current;

        // ── Background: plasma + grid + nodes + scanlines + vignette ──
        drawBackground(ctx, t, creatureState);

        // ── Slime creature ──
        const charX = pos.x * TILE + TILE / 2 - DISPLAY_SIZE / 2;
        const charY = pos.y * TILE + TILE - DISPLAY_SIZE;

        let squish = 0;
        let bobOffset = 0;
        if (moving) {
          const phase = movePhaseRef.current;
          if (phase === 0) squish = -0.8;
          else if (phase === 1) { squish = 0.3; bobOffset = -1; }
          else if (phase === 2) { squish = 0.6; bobOffset = -2; }
          else { squish = -0.3; bobOffset = 0; }
        } else {
          bobOffset = Math.sin(t * 0.003) * 0.5;
          squish = Math.sin(t * 0.002) * 0.15;
        }

        const eyeShiftX = moving ? Math.sign(dx) * 1 : 0;
        const eyeShiftY = moving ? Math.sign(dy) * 0.5 : 0;
        const colorState = creatureState === "reflecting" ? "reflecting"
          : creatureState === "planning" ? "planning"
          : "default";

        const frame = renderSlimeFrame(colorState, squish, bobOffset, eyeShiftX, eyeShiftY);
        blitSlimeFrame(ctx, frame, charX, charY);

        // ── State indicators ──
        const indicatorX = charX + DISPLAY_SIZE / 2;
        const indicatorY = charY - 8;

        if (creatureState === "thinking") drawThinkingBubble(ctx, indicatorX, indicatorY);
        else if (creatureState === "reflecting") drawReflectionSparkle(ctx, indicatorX, indicatorY, t);
        else if (creatureState === "planning") drawPlanningClipboard(ctx, indicatorX, indicatorY);

        if (conversingRef.current) drawConversingBubble(ctx, indicatorX, indicatorY);
        if (alertRef.current) drawAlertBubble(ctx, indicatorX, indicatorY, t);

        // Activity indicator to the right
        const act = activityRef.current;
        if (act.type !== "idle" && act.type !== "moving") {
          const actX = charX + DISPLAY_SIZE + 8;
          const actY = charY + DISPLAY_SIZE / 2;
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

        // Activity detail text — bottom bar
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
    }, []);

    return (
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{
          width: "100%",
          maxWidth: W * 2,
          imageRendering: "pixelated",
          borderRadius: 8,
        }}
      />
    );
  },
);

export default GameWorld;
