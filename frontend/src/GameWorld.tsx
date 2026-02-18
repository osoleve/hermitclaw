/**
 * Fold substrate room and slime creature rendered on HTML5 Canvas.
 * Procedural animation — no sprite sheets.
 */

import { useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { COLS, ROWS, TILE, LOCATIONS, PALETTE, SLIME, GRID } from "./world";

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

export interface GameWorldHandle {
  snapshot: () => string;
}

// Ambient particle state
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alpha: number;
  radius: number;
}

function createParticles(): Particle[] {
  const particles: Particle[] = [];
  for (let i = 0; i < GRID.particleCount; i++) {
    particles.push({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * GRID.particleDriftSpeed,
      vy: (Math.random() - 0.5) * GRID.particleDriftSpeed,
      alpha: GRID.particleMinAlpha + Math.random() * (GRID.particleMaxAlpha - GRID.particleMinAlpha),
      radius: 0.5 + Math.random() * GRID.particleMaxRadius,
    });
  }
  return particles;
}

function updateParticles(particles: Particle[]) {
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    // Wrap around edges
    if (p.x < 0) p.x += W;
    if (p.x > W) p.x -= W;
    if (p.y < 0) p.y += H;
    if (p.y > H) p.y -= H;
    // Gentle alpha oscillation
    p.alpha += (Math.random() - 0.5) * 0.01;
    p.alpha = Math.max(GRID.particleMinAlpha, Math.min(GRID.particleMaxAlpha, p.alpha));
  }
}

// --- Drawing functions ---

function drawGrid(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = GRID.lineColor;
  ctx.lineWidth = 0.5;
  // Vertical lines
  for (let x = 0; x <= COLS; x++) {
    ctx.beginPath();
    ctx.moveTo(x * TILE, 0);
    ctx.lineTo(x * TILE, H);
    ctx.stroke();
  }
  // Horizontal lines
  for (let y = 0; y <= ROWS; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * TILE);
    ctx.lineTo(W, y * TILE);
    ctx.stroke();
  }
}

function drawLocationNodes(ctx: CanvasRenderingContext2D, t: number) {
  ctx.font = "8px 'IBM Plex Mono', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  const seen = new Set<string>();
  for (const [, loc] of Object.entries(LOCATIONS)) {
    const key = `${loc.x},${loc.y}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const cx = loc.x * TILE + TILE / 2;
    const cy = loc.y * TILE + TILE / 2;
    const pulse = 1 + Math.sin(t * 0.002 + loc.x * 0.7) * 0.3;

    // Glow circle
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, GRID.nodeRadius * 3 * pulse);
    grad.addColorStop(0, GRID.nodeGlow);
    grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, GRID.nodeRadius * 3 * pulse, 0, Math.PI * 2);
    ctx.fill();

    // Core dot
    ctx.fillStyle = `rgba(0, 229, 160, ${0.25 + pulse * 0.1})`;
    ctx.beginPath();
    ctx.arc(cx, cy, GRID.nodeRadius * pulse * 0.5, 0, Math.PI * 2);
    ctx.fill();

    // Label
    ctx.fillStyle = GRID.nodeLabelColor;
    ctx.fillText(loc.label, cx, cy + GRID.nodeRadius * 3 + 2);
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, particles: Particle[]) {
  for (const p of particles) {
    ctx.fillStyle = `rgba(0, 229, 160, ${p.alpha})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSlime(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  t: number,
  moving: boolean,
  dx: number,
  dy: number,
  state: string,
) {
  ctx.save();
  ctx.translate(cx, cy);

  // Stretch-squash when moving
  if (moving) {
    const angle = Math.atan2(dy, dx);
    ctx.rotate(angle);
    ctx.scale(SLIME.stretchFactor, SLIME.squashFactor);
    ctx.rotate(-angle);
  }

  // Breathing
  const breathOffset = Math.sin(t * SLIME.breathSpeed) * SLIME.breathAmp;
  const r = SLIME.baseRadius + breathOffset;

  // Build deformed perimeter path
  ctx.beginPath();
  for (let i = 0; i <= SLIME.controlPoints; i++) {
    const angle = (i / SLIME.controlPoints) * Math.PI * 2;
    const wobble = Math.sin(t * SLIME.wobbleSpeed + i * 1.7) * SLIME.wobbleAmp;
    const pr = r + wobble;
    const px = Math.cos(angle) * pr;
    const py = Math.sin(angle) * pr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();

  // Fill with radial gradient — core color depends on state
  let coreColor: string = PALETTE.glow;
  let edgeColor = "rgba(0, 229, 160, 0.12)";
  let glowColor: string = PALETTE.glow;

  if (state === "reflecting") {
    coreColor = PALETTE.dream;
    edgeColor = "rgba(167, 139, 250, 0.12)";
    glowColor = PALETTE.dream;
  } else if (state === "planning") {
    coreColor = PALETTE.plan;
    edgeColor = "rgba(52, 211, 153, 0.12)";
    glowColor = PALETTE.plan;
  }

  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r + SLIME.wobbleAmp);
  grad.addColorStop(0, coreColor);
  grad.addColorStop(0.4, coreColor + "88");
  grad.addColorStop(1, edgeColor);
  ctx.fillStyle = grad;
  ctx.fill();

  // Drop shadow/glow underneath
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 20;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Eyes — shift toward movement direction
  const eyeShiftX = moving ? Math.sign(dx) * SLIME.eyeShiftMax : 0;
  const eyeShiftY = moving ? Math.sign(dy) * SLIME.eyeShiftMax : 0;
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.beginPath();
  ctx.arc(-SLIME.eyeOffset + eyeShiftX, -3 + eyeShiftY, SLIME.eyeRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(SLIME.eyeOffset + eyeShiftX, -3 + eyeShiftY, SLIME.eyeRadius, 0, Math.PI * 2);
  ctx.fill();

  // Pupil dots
  ctx.fillStyle = coreColor;
  ctx.beginPath();
  ctx.arc(-SLIME.eyeOffset + eyeShiftX * 1.3, -3 + eyeShiftY * 1.3, SLIME.eyeRadius * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(SLIME.eyeOffset + eyeShiftX * 1.3, -3 + eyeShiftY * 1.3, SLIME.eyeRadius * 0.45, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawStateIndicator(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  t: number,
  state: string,
  alertActive: boolean,
  conversing: boolean,
) {
  const aboveY = cy - SLIME.baseRadius - 14;

  // Thinking: orbiting particles
  if (state === "thinking") {
    for (let i = 0; i < 4; i++) {
      const angle = (t * 0.004) + (i * Math.PI / 2);
      const ox = cx + Math.cos(angle) * 14;
      const oy = aboveY + Math.sin(angle) * 6;
      ctx.fillStyle = `rgba(0, 229, 160, ${0.5 + Math.sin(t * 0.006 + i) * 0.3})`;
      ctx.beginPath();
      ctx.arc(ox, oy, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Reflecting: purple sparkle ring
  if (state === "reflecting") {
    for (let i = 0; i < 6; i++) {
      const angle = (t * 0.003) + (i * Math.PI / 3);
      const dist = 22 + Math.sin(t * 0.005 + i) * 3;
      const sx = cx + Math.cos(angle) * dist;
      const sy = cy + Math.sin(angle) * dist;
      const sparkleAlpha = 0.4 + Math.sin(t * 0.008 + i * 1.2) * 0.3;
      ctx.fillStyle = `rgba(167, 139, 250, ${sparkleAlpha})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Planning: brief wireframe flash lines
  if (state === "planning") {
    const flash = Math.sin(t * 0.006) * 0.5 + 0.5;
    ctx.strokeStyle = `rgba(52, 211, 153, ${flash * 0.4})`;
    ctx.lineWidth = 0.5;
    const r = SLIME.baseRadius + 10;
    // Hexagon outline
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const px = cx + Math.cos(angle) * r;
      const py = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // Conversing: concentric ripple rings
  if (conversing) {
    for (let i = 0; i < 3; i++) {
      const phase = ((t * 0.003) + i * 0.33) % 1;
      const rippleR = 20 + phase * 30;
      const alpha = (1 - phase) * 0.3;
      ctx.strokeStyle = `rgba(249, 115, 22, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, rippleR, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Alert: pulsing red glow halo
  if (alertActive) {
    const pulse = 0.4 + Math.sin(t * 0.006) * 0.3;
    const grad = ctx.createRadialGradient(cx, cy, SLIME.baseRadius, cx, cy, SLIME.baseRadius + 16);
    grad.addColorStop(0, `rgba(248, 113, 113, ${pulse})`);
    grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, SLIME.baseRadius + 16, 0, Math.PI * 2);
    ctx.fill();
  }
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
    const particlesRef = useRef<Particle[]>(createParticles());
    // Sticky activity: holds last non-idle activity for HOLD_MS with fade-out
    const stickyActivityRef = useRef<{ detail: string; time: number } | null>(null);

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
      let animId: number;
      let running = true;

      const render = () => {
        if (!running) return;
        const t = Date.now();
        const pos = posRef.current;
        const target = targetRef.current;
        const rawDx = target.x - pos.x;
        const rawDy = target.y - pos.y;
        const moving = Math.abs(rawDx) > 0.02 || Math.abs(rawDy) > 0.02;

        if (moving) {
          pos.x += rawDx * 0.08;
          pos.y += rawDy * 0.08;
        } else {
          pos.x = target.x;
          pos.y = target.y;
        }

        // Clear with void color
        ctx.fillStyle = PALETTE.void;
        ctx.fillRect(0, 0, W, H);

        // Draw room layers
        drawGrid(ctx);
        updateParticles(particlesRef.current);
        drawParticles(ctx, particlesRef.current);
        drawLocationNodes(ctx, t);

        // Creature position in pixel coords
        const cx = pos.x * TILE + TILE / 2;
        const cy = pos.y * TILE + TILE / 2;

        // State indicators (behind creature)
        drawStateIndicator(ctx, cx, cy, t, stateRef.current, alertRef.current, conversingRef.current);

        // Slime creature
        drawSlime(ctx, cx, cy, t, moving, rawDx, rawDy, stateRef.current);

        // Activity detail text (bottom overlay) — sticky with fade-out
        const HOLD_MS = 3000;
        const FADE_MS = 800;
        const act = activityRef.current;
        if (act.type !== "idle" && act.detail) {
          stickyActivityRef.current = { detail: act.detail, time: t };
        }
        const sticky = stickyActivityRef.current;
        if (sticky) {
          const age = t - sticky.time;
          if (age < HOLD_MS + FADE_MS) {
            const alpha = age < HOLD_MS ? 1 : 1 - (age - HOLD_MS) / FADE_MS;
            const label = sticky.detail.length > 50
              ? sticky.detail.slice(0, 50) + "..."
              : sticky.detail;
            ctx.fillStyle = `rgba(8, 12, 20, ${0.8 * alpha})`;
            ctx.fillRect(0, H - 22, W, 22);
            ctx.fillStyle = PALETTE.computation;
            ctx.globalAlpha = alpha;
            ctx.font = "10px 'IBM Plex Mono', monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, W / 2, H - 11);
            ctx.globalAlpha = 1;
          } else {
            stickyActivityRef.current = null;
          }
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
          borderRadius: 8,
          background: PALETTE.void,
        }}
      />
    );
  },
);

export default GameWorld;
