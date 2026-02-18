/**
 * Sprite sheet loader and animation system for MMBN-style pixel art rendering.
 */

// --- Types ---

export interface FrameRect {
  x: number; // pixel x in sheet
  y: number; // pixel y in sheet
  w: number; // frame width
  h: number; // frame height
}

export interface AnimationDef {
  frames: FrameRect[];
  frameDuration: number; // ms per frame
  loop: boolean;
}

export interface SpriteSheetDef {
  imageSrc: string;
  frameWidth: number;
  frameHeight: number;
  animations: Record<string, AnimationDef>;
}

export interface AnimationState {
  currentAnim: string;
  frameIndex: number;
  lastFrameTime: number;
}

// --- Image loading with cache ---

const imageCache = new Map<string, HTMLImageElement>();
const loadingPromises = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached) return Promise.resolve(cached);

  const existing = loadingPromises.get(src);
  if (existing) return existing;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(src, img);
      loadingPromises.delete(src);
      resolve(img);
    };
    img.onerror = () => {
      loadingPromises.delete(src);
      reject(new Error(`Failed to load image: ${src}`));
    };
    img.src = src;
  });

  loadingPromises.set(src, promise);
  return promise;
}

// --- Animation state machine ---

export function tickAnimation(
  state: AnimationState,
  anim: AnimationDef,
  now: number,
): AnimationState {
  const elapsed = now - state.lastFrameTime;
  if (elapsed < anim.frameDuration) return state;

  const frameCount = anim.frames.length;
  let nextIndex = state.frameIndex + 1;

  if (nextIndex >= frameCount) {
    nextIndex = anim.loop ? 0 : frameCount - 1;
  }

  return {
    currentAnim: state.currentAnim,
    frameIndex: nextIndex,
    lastFrameTime: now,
  };
}

export function getCurrentFrame(
  state: AnimationState,
  anim: AnimationDef,
): FrameRect {
  return anim.frames[state.frameIndex] || anim.frames[0];
}

export function setAnimation(
  state: AnimationState,
  animName: string,
  now: number,
): AnimationState {
  if (state.currentAnim === animName) return state;
  return { currentAnim: animName, frameIndex: 0, lastFrameTime: now };
}

// --- Drawing ---

export interface DrawSpriteOpts {
  flipX?: boolean;
  tint?: string;
  tintAmount?: number; // 0-1
  alpha?: number;
  scale?: number;
}

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sheet: HTMLImageElement,
  frame: FrameRect,
  destX: number,
  destY: number,
  opts: DrawSpriteOpts = {},
): void {
  const scale = opts.scale ?? 1;
  const dw = frame.w * scale;
  const dh = frame.h * scale;
  const dx = destX - dw / 2;
  const dy = destY - dh / 2;

  ctx.save();

  if (opts.alpha !== undefined) {
    ctx.globalAlpha = opts.alpha;
  }

  if (opts.flipX) {
    ctx.translate(destX, 0);
    ctx.scale(-1, 1);
    ctx.translate(-destX, 0);
  }

  ctx.drawImage(sheet, frame.x, frame.y, frame.w, frame.h, dx, dy, dw, dh);

  // Color tint overlay
  if (opts.tint && (opts.tintAmount ?? 0) > 0) {
    ctx.globalCompositeOperation = "source-atop";
    ctx.globalAlpha = opts.tintAmount ?? 0.3;
    ctx.fillStyle = opts.tint;
    ctx.fillRect(dx, dy, dw, dh);
  }

  ctx.restore();
}

// --- Helper: generate frame rects for a grid-based sprite sheet ---

export function gridFrames(
  col: number,
  row: number,
  count: number,
  fw: number,
  fh: number,
): FrameRect[] {
  const frames: FrameRect[] = [];
  for (let i = 0; i < count; i++) {
    frames.push({ x: (col + i) * fw, y: row * fh, w: fw, h: fh });
  }
  return frames;
}
