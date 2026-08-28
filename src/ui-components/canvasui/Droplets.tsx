"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Weather & Enemies C2 — rain-on-glass refraction, matching the upstream
 * "Canvas UI" Droplets component's documented option set (canvasui.dev/docs
 * /components/droplets: intensity, speed, drop width/length, refraction
 * strength, blur, vignette darkening, tint color/strength, interactive
 * pointer-wipe). This project has no network access to fetch that library's
 * actual source at build time, so this is a from-scratch WebGL2 GLSL
 * implementation of the same documented behavior/option vocabulary, built
 * with the exact shader-effect ARCHITECTURE the other three ported
 * components (Glitch/VHS/ForceField) already established here: a vertex+
 * fragment WebGL2 program, a uniform-driven options object, a
 * visibility/reduced-motion-gated requestAnimationFrame loop, a
 * ResizeObserver, and a destroy() that releases every GPU resource.
 *
 * **Real, deliberate architectural split from Glitch/VHS/ForceField/Peel,
 * confirmed by a real technical spike (see C2's own final report for the
 * measured evidence) — read this before changing the `elements` shape:**
 * those four components all capture *static HTML* onto a canvas via the
 * experimental Canvas 2D `drawElementImage()` + `layoutsubtree` "html in
 * canvas" API (see their own `supportsHtmlInCanvas()`), which:
 *   1. Is confirmed NOT supported in this project's real target Chromium
 *      (verified directly: `ctx.drawElementImage` and
 *      `canvas.requestPaint` are both `undefined` in a real
 *      `chromium.launch()` session using this project's own GPU launch
 *      args — see scripts/db/lib/browser.mjs). Every one of those four
 *      components is ALREADY silently running its non-WebGL fallback path
 *      in this app today, not just Peel (whose own doc comment already
 *      flagged this for its own case). This is a genuine pre-existing
 *      product finding, not something this prompt introduces.
 *   2. Would be the wrong tool for a LIVE, continuously-updating WebGL
 *      surface even where it did exist — capturing one live WebGL canvas's
 *      presented pixels through a second canvas's 2D paint callback adds a
 *      layer of paint-timing uncertainty this effect doesn't need.
 * Droplets instead reads the Game Room's own R3F renderer canvas
 * (`state.gl.domElement` from `<Canvas onCreated>`) directly as a WebGL
 * texture source every animation frame via `gl.texImage2D(..., canvasEl)`
 * — a completely standard, non-experimental part of the WebGL spec (any
 * `HTMLCanvasElement`, WebGL- or 2D-backed, is a valid texture source for
 * another, independent WebGL context, same-origin tainting rules aside).
 * A synthetic two-canvas spike (one live-animating WebGL2 source, a second
 * independent WebGL2 context sampling it every rAF) confirmed pixel-exact,
 * zero-lag capture across 10 consecutive frames. `source` here is that live
 * canvas element directly — there is no `content` DOM node to capture, so
 * unlike GlitchElements/VHSElements/ForceFieldElements this has no
 * `content` field at all.
 *
 * `preserveDrawingBuffer` judgment call: the spike's own same-task capture
 * (render source, then immediately capture) matched every sampled frame
 * even WITHOUT `preserveDrawingBuffer` on the source context, because nothing
 * had cleared the drawing buffer between the two calls yet — the browser
 * only clears/invalidates a WebGL backbuffer once it composites the frame,
 * which happens after the current task returns. But Droplets' own capture
 * loop is a structurally SEPARATE rAF loop from R3F's internal render loop,
 * with no ordering guarantee between the two (R3F may use
 * `setAnimationLoop` internally, and browsers are free to reorder/throttle
 * independently-registered rAF callbacks). Relying on same-task ordering
 * that isn't actually guaranteed would risk a rare, hard-to-reproduce
 * blank/stale-frame flicker. GameRoom.tsx's `<Canvas gl={{
 * preserveDrawingBuffer: true }}>` removes that race outright at a small,
 * measured perf cost (see the C2 report's frame-time numbers) — the
 * defensively-correct choice over a cheaper but non-deterministic one.
 */
export interface DropletsOptions {
  /** Overall strength of the refraction/highlight effect (0 to 1.25). */
  intensity?: number;
  /** Speed multiplier for the falling drops. */
  speed?: number;
  /** Relative width of each drop's refraction lobe (0.05 to 1). */
  dropWidth?: number;
  /** Relative length of each drop's trailing streak (0.5 to 4). */
  dropLength?: number;
  /** Strength of the background UV distortion under each drop (0 to 0.15). */
  refraction?: number;
  /** Softness applied to the background where drops sit wet (0 to 1). */
  blur?: number;
  /** Darkening toward the frame corners (0 to 1). */
  vignette?: number;
  /** Cold-glass tint color as [r, g, b] in 0-1 range. */
  tintColor?: [number, number, number];
  /** Strength of the tint blend (0 to 1). */
  tintStrength?: number;
  /**
   * Documented upstream option (interactive pointer-wipe: dragging a finger
   * clears a dry streak through the drops). Deliberately NOT wired up in
   * this prompt — Weather & Enemies C2's own acceptance criteria calls for
   * leaving it off so the overlay never competes with real scene pointer
   * events (clicking cells, dragging chairs, opening panels). Kept in the
   * option shape for parity with the upstream vocabulary and so a later
   * fine-tuning pass can wire it up without changing this interface; it is
   * currently a documented no-op if passed.
   */
  interactive?: boolean;
}

export interface DropletsElements {
  /** The Game Room's own live R3F canvas — captured directly, every frame,
   * as a WebGL texture source. NOT a static HTML capture target (see this
   * file's own top-of-file doc comment for why Droplets has no `content`
   * field, unlike Glitch/VHS/ForceField/Peel). */
  source: HTMLCanvasElement;
  /** Canvas the rain shader renders to — sits visually on top of `source`
   * as a same-size overlay. */
  output: HTMLCanvasElement;
}

export interface DropletsInstance {
  /** Update effect options live. */
  setOptions: (options: DropletsOptions) => void;
  /** Fade the effect in or out. Kept mounted either way (GameRoom mounts
   * Droplets once, always, per C2's own Task: "an always-present overlay
   * that is only visually active when weather_kind is 'rain'") — this
   * avoids recreating the WebGL context (and its capture loop) on every
   * weather change. */
  setActive: (active: boolean) => void;
  /** Re-read canvas size. Call when the element is resized. */
  resize: () => void;
  /** Stop the loop and release all GPU resources. */
  destroy: () => void;
}

const DEFAULTS: Required<Omit<DropletsOptions, "interactive">> = {
  intensity: 0.85,
  speed: 1,
  dropWidth: 0.06,
  dropLength: 4.0,
  refraction: 0.045,
  blur: 0.4,
  vignette: 0.3,
  tintColor: [0.53, 0.58, 0.66],
  tintStrength: 0.06,
};

// How many times the Droplets React component retries a failed
// `output.getContext("webgl2", ...)` call before giving up for the rest of
// this mount — see the retry loop in the Droplets component below for why
// this is worth retrying at all (transient context exhaustion) rather than
// treating every failure as permanent.
const CONTEXT_CREATE_MAX_RETRIES = 3;
const CONTEXT_RETRY_DELAY_MS = 300;

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main () {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// A from-scratch rain-on-glass shader (see this file's top-of-file doc
// comment on why it's not a literal upstream port): three independently
// scaled/seeded layers of falling drops, each contributing a UV-space
// refraction vector plus a "wetness" mask, summed and used to (a) bend the
// sampled background UV, (b) soften the background under wet patches, and
// (c) add a small specular highlight on each drop's leading edge — then a
// vignette and a cold-glass tint on top, same finishing touches VHS.tsx
// already uses for its own scanline/vignette/saturation pass.
const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uContent;
uniform vec2 uResolution;
uniform float uTime;
uniform float uIntensity;
uniform float uSpeed;
uniform float uDropWidth;
uniform float uDropLength;
uniform float uRefraction;
uniform float uBlur;
uniform float uVignette;
uniform vec3 uTintColor;
uniform float uTintStrength;
uniform float uAlpha;

float hash21 (vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// One layer of falling drop streaks at a given cell density/speed/seed.
// Returns (distortion.xy, wetnessMask) for that layer alone.
vec3 dropLayer (vec2 uv, float scale, float speedMul, float seed) {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 grid = vec2(uv.x * aspect, uv.y) * scale;
  vec2 cellId = floor(grid);
  vec2 cellUv = fract(grid) - 0.5;

  float rnd = hash21(cellId + seed);
  float fallSpeed = 0.35 + rnd * 0.65;
  float phase = fract(uTime * uSpeed * speedMul * fallSpeed + rnd * 11.0);
  float dropY = mix(-0.55, 0.55, phase);
  vec2 toDrop = cellUv - vec2((rnd - 0.5) * 0.7, dropY);
  toDrop.y /= max(uDropLength, 0.05);
  float trailFade = 0.35 + 0.65 * smoothstep(1.0, 0.0, phase);
  float d = length(toDrop) / max(uDropWidth, 0.02);
  float mask = smoothstep(1.0, 0.0, d) * trailFade;
  vec2 grad = toDrop * mask;
  return vec3(grad, mask);
}

void main () {
  vec2 uv = vUv;

  vec3 a = dropLayer(uv, 5.5, 1.0, 0.0);
  vec3 b = dropLayer(uv, 9.0, 1.35, 17.0);
  vec3 c = dropLayer(uv, 3.3, 0.7, 41.0);
  vec2 distortion = a.xy + b.xy * 0.7 + c.xy * 0.5;
  float wetness = clamp(a.z + b.z * 0.7 + c.z * 0.5, 0.0, 1.5);

  vec2 refracted = clamp(uv + distortion * uRefraction * uIntensity, vec2(0.001), vec2(0.999));
  vec2 sampleUv = vec2(refracted.x, 1.0 - refracted.y);
  vec3 color = texture(uContent, sampleUv).rgb;

  if (uBlur > 0.001) {
    vec2 o = uBlur * 0.0035 * vec2(1.0, uResolution.x / max(uResolution.y, 1.0));
    vec3 blurred = color;
    blurred += texture(uContent, sampleUv + vec2(o.x, 0.0)).rgb;
    blurred += texture(uContent, sampleUv - vec2(o.x, 0.0)).rgb;
    blurred += texture(uContent, sampleUv + vec2(0.0, o.y)).rgb;
    blurred += texture(uContent, sampleUv - vec2(0.0, o.y)).rgb;
    blurred *= 0.2;
    color = mix(color, blurred, clamp(wetness, 0.0, 1.0));
  }

  float highlight = smoothstep(0.55, 1.0, wetness) * 0.22 * uIntensity;
  color += highlight;

  vec2 vd = (uv - 0.5) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
  color *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(vd));

  color = mix(color, uTintColor, clamp(uTintStrength, 0.0, 1.0));

  outColor = vec4(clamp(color, 0.0, 1.0), clamp(uAlpha, 0.0, 1.0));
}`;

export function supportsDroplets(): boolean {
  if (typeof document === "undefined") return false;
  const probe = document.createElement("canvas");
  return Boolean(probe.getContext("webgl2"));
}

export function createDroplets(
  elements: DropletsElements,
  options: DropletsOptions = {},
): DropletsInstance | null {
  const config = { ...DEFAULTS, ...options };
  const { source, output } = elements;

  const gl = output.getContext("webgl2", {
    alpha: true,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false,
  });
  if (!gl || gl.isContextLost()) return null;

  function compile(type: number, text: string): WebGLShader {
    const shader = gl!.createShader(type)!;
    gl!.shaderSource(shader, text);
    gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
      console.error("Droplets shader error:", gl!.getShaderInfoLog(shader));
    }
    return shader;
  }

  const vertexShader = compile(gl.VERTEX_SHADER, VERT);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram()!;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  const uniforms: Record<string, WebGLUniformLocation> = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i)!;
    uniforms[info.name] = gl.getUniformLocation(program, info.name)!;
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const contentTexture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, contentTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0]),
  );

  function syncCanvasSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(output.clientWidth * dpr));
    const height = Math.max(1, Math.round(output.clientHeight * dpr));
    if (output.width !== width || output.height !== height) {
      output.width = width;
      output.height = height;
    }
  }

  syncCanvasSize();

  // The actual capture call: read the live Game Room canvas's CURRENT
  // drawing-buffer content directly as a texture source, every active
  // frame — see this file's top-of-file doc comment for why this replaces
  // Glitch/VHS's own drawElementImage-based DOM capture entirely.
  function uploadContent() {
    if (source.width === 0 || source.height === 0) return;
    gl!.bindTexture(gl!.TEXTURE_2D, contentTexture);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, source);
  }

  let time = 0;
  let alpha = 0;
  let targetAlpha = 0;

  function render() {
    uploadContent();
    gl!.useProgram(program);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, contentTexture);
    gl!.uniform1i(uniforms.uContent, 0);
    gl!.uniform2f(uniforms.uResolution, output.width, output.height);
    gl!.uniform1f(uniforms.uTime, time);
    gl!.uniform1f(uniforms.uIntensity, Math.max(config.intensity, 0));
    gl!.uniform1f(uniforms.uSpeed, Math.max(config.speed, 0));
    gl!.uniform1f(uniforms.uDropWidth, Math.max(config.dropWidth, 0.02));
    gl!.uniform1f(uniforms.uDropLength, Math.max(config.dropLength, 0.05));
    gl!.uniform1f(uniforms.uRefraction, Math.max(config.refraction, 0));
    gl!.uniform1f(uniforms.uBlur, Math.max(config.blur, 0));
    gl!.uniform1f(uniforms.uVignette, Math.max(config.vignette, 0));
    gl!.uniform3f(uniforms.uTintColor, config.tintColor[0], config.tintColor[1], config.tintColor[2]);
    gl!.uniform1f(uniforms.uTintStrength, Math.max(config.tintStrength, 0));
    gl!.uniform1f(uniforms.uAlpha, alpha);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, output.width, output.height);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
  }

  // Directly clears the drawing buffer to fully transparent (0,0,0,0),
  // bypassing the shader/uniform pipeline entirely — a plain <canvas>
  // retains whatever pixels were last presented once its rAF loop stops
  // scheduling new frames, so relying on the shader ever actually being
  // asked to draw an alpha=0 frame isn't enough: the loop can be halted
  // (visibility going false, an unmount, or normal fade completion) at a
  // point where the LAST frame it drew was still mid-fade (alpha > 0). This
  // is the single point every stop path below routes through so a stale,
  // non-transparent frame can never persist visibly once the effect is
  // supposed to be inactive.
  function clearToTransparent() {
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, output.width, output.height);
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
  }

  function stopLoop() {
    running = false;
    clearToTransparent();
  }

  let raf = 0;
  let lastTime = performance.now();
  let destroyed = false;
  let running = false;
  let visible = true;

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = motionQuery.matches;

  function frame(now: number) {
    if (destroyed) return;
    if (!visible) {
      // The IntersectionObserver callback below can flip `visible` to false
      // between rAF callbacks (it's not itself tied to the animation
      // frame), including mid-fade while `alpha` is still well above 0. Left
      // alone, this branch used to just stop scheduling frames — freezing
      // whatever partially-faded frame was last drawn onto the canvas
      // indefinitely, sitting directly over the live 3D scene. Force a
      // fully-transparent frame instead, unconditionally.
      stopLoop();
      return;
    }
    const delta = Math.min(Math.max((now - lastTime) / 1000, 0), 1 / 30);
    lastTime = now;
    // Matches VHS.tsx's own precedent: reduced motion freezes the
    // decorative animation's own clock (the falling-drop pattern), but the
    // captured background still updates every frame — the live 3D scene's
    // own motion is unrelated to this effect's decorative motion and must
    // never visibly lag behind just because the user prefers less of ours.
    if (!reducedMotion) time += delta;
    alpha += (targetAlpha - alpha) * Math.min(delta * 10, 1);
    if (Math.abs(targetAlpha - alpha) < 0.002) alpha = targetAlpha;
    render();
    if (targetAlpha === 0 && alpha === 0) {
      // render() above already drew this frame at uAlpha=0, but stopLoop's
      // own direct clear is kept as the defensive, shader-independent
      // guarantee rather than trusting the uniform pipeline alone — cheap
      // (one extra clear on the rare frame the loop actually stops) and
      // makes every stop path share the exact same "must end up
      // transparent" invariant.
      stopLoop();
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (destroyed || running || !visible) return;
    running = true;
    lastTime = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function onMotionChange() {
    reducedMotion = motionQuery.matches;
  }
  motionQuery.addEventListener("change", onMotionChange);

  const observer = new ResizeObserver(() => {
    syncCanvasSize();
    if (targetAlpha > 0 || alpha > 0) start();
  });
  observer.observe(output);

  const intersection = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1]?.isIntersecting ?? true;
    if (visible && (targetAlpha > 0 || alpha > 0)) start();
  });
  intersection.observe(output);

  // Render one fully-transparent frame immediately so the overlay never
  // shows a stale/undefined frame before the first real activation.
  render();

  return {
    setOptions(next) {
      Object.assign(config, next);
      if (targetAlpha > 0 || alpha > 0) start();
    },
    setActive(active) {
      targetAlpha = active ? 1 : 0;
      start();
    },
    resize() {
      syncCanvasSize();
      if (targetAlpha > 0 || alpha > 0) start();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      // Same "must never leave a stale frame visible" invariant as every
      // stop path in frame() above — an unmount is still a way the loop
      // stops, and this canvas element isn't guaranteed to be removed from
      // the DOM synchronously with this call (React's commit is a separate
      // step), so force it transparent before releasing GPU resources.
      clearToTransparent();
      observer.disconnect();
      intersection.disconnect();
      motionQuery.removeEventListener("change", onMotionChange);
      gl!.deleteTexture(contentTexture);
      gl!.deleteProgram(program);
      gl!.deleteShader(vertexShader);
      gl!.deleteShader(fragmentShader);
      gl!.deleteBuffer(quad);
    },
  };
}

export interface DropletsProps extends DropletsOptions {
  /** The Game Room's own live R3F canvas element (from `<Canvas onCreated>`
   * — see GameRoom.tsx), or null before it's mounted. Droplets renders
   * nothing until this is available. */
  sourceCanvas: HTMLCanvasElement | null;
  /** Only visually active when true — see DropletsInstance.setActive's own
   * doc comment on why this fades rather than unmounts. */
  active: boolean;
  /** Fires whenever the WebGL2 instance's own ready/failed status changes —
   * exists so a real Playwright check (verify-rain.mjs) can confirm the
   * effect genuinely initialized rather than silently degrading to nothing,
   * the same "no silent placeholder" bar this prompt's own acceptance
   * criteria sets, without needing to pixel-diff a screenshot just to know
   * whether a shader is even running. */
  onStatusChange?: (status: { ready: boolean }) => void;
  className?: string;
  style?: React.CSSProperties;
}

export function Droplets({
  sourceCanvas,
  active,
  onStatusChange,
  className,
  style,
  ...options
}: DropletsProps) {
  const outputRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<DropletsInstance | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const output = outputRef.current;
    if (!output || !sourceCanvas) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    // `output.getContext("webgl2", ...)` can fail — plausibly WebGL2
    // context exhaustion, since every Game Room tab already runs one
    // WebGL2 context for R3F, and switching weather kinds while a prior
    // Droplets instance's context wasn't fully released can leave the
    // browser/GPU momentarily at whatever concurrent-context limit it
    // enforces. That's typically a transient condition (freed once garbage
    // collection or another tab's context release catches up), not a
    // permanent one, so retry a few times with a short backoff before
    // giving up — a single failed attempt used to permanently leave
    // `ready:false` with no way for GameRoom.tsx to ever roll back
    // `dropletsMounted` or retry itself.
    function attempt(retriesLeft: number) {
      if (cancelled || !sourceCanvas) return;
      const instance = createDroplets({ source: sourceCanvas, output: output! }, options);
      instanceRef.current = instance;
      if (instance) {
        // `active` here is THIS render's own prop value, not stale — this
        // effect only ever actually runs (vs. just being redeclared) when
        // `sourceCanvas` changes, and each such run necessarily executes
        // the closure from the render that made it change, so whatever
        // `active` was passed on THAT render is already current. Handles
        // the common case where `sourceCanvas` arrives (R3F's `onCreated`,
        // one render after mount) while `active` is already true (e.g. a
        // campaign that loads with weather already set to 'rain').
        instance.setActive(active);
        onStatusChange?.({ ready: true });
        return;
      }
      onStatusChange?.({ ready: false });
      if (retriesLeft > 0) {
        retryTimer = setTimeout(() => attempt(retriesLeft - 1), CONTEXT_RETRY_DELAY_MS);
      } else {
        // Retries exhausted — give up for good this mount. Setting `failed`
        // makes this component render `null` (see the render guard below),
        // which removes its own output <canvas> from the DOM entirely: the
        // one guarantee that matters here is that a permanently-broken
        // WebGL2 context can never leave stale/broken canvas content
        // visible, even though the rain effect itself stays unavailable
        // for the rest of this session.
        setFailed(true);
      }
    }

    attempt(CONTEXT_CREATE_MAX_RETRIES);

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      instanceRef.current?.destroy();
      instanceRef.current = null;
      onStatusChange?.({ ready: false });
    };
    // Only recreated when the source canvas element itself changes — option
    // and active updates flow through the effects below instead, same as
    // Glitch/VHS's own setOptions-only-on-change split.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceCanvas]);

  useEffect(() => {
    instanceRef.current?.setOptions(options);
  });

  useEffect(() => {
    instanceRef.current?.setActive(active);
  }, [active]);

  if (failed || !sourceCanvas) return null;

  return (
    <canvas
      ref={outputRef}
      aria-hidden
      className={className}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        ...style,
      }}
    />
  );
}

export default Droplets;
