#!/usr/bin/env node
// Skeleton-based posing perf + real-GPU correctness check
// (docs/design/model-orientation-and-posing.md §7/§9, Prompt "real posing
// for seated characters and placed NPC/enemy models"). The design doc's own
// §7 benchmark measured AnimationMixer.update() cost in isolation, on plain
// Node, against a synthetic per-frame loop — explicitly flagged as NOT
// covering "real GPU skinning/draw cost with realistically-detailed
// character meshes" and asked for exactly this follow-up: a real headless
// Chromium/GPU harness, extending scripts/perf/asset-render-benchmark.mjs's
// own pattern, loading N real animated skinned instances and checking
// against perf-budgets.json's render3d budget.
//
// Two things this script actually proves, both against the REAL,
// committed test fixtures (public/test-fixtures/, not synthetic geometry):
//   1. Correctness, in a real browser: RiggedFigure.glb (a conforming
//      skeleton) ends up genuinely posed — its bone quaternions differ from
//      rest — and RiggedSimple.glb (a 2-bone, non-conforming skeleton)
//      falls back to exactly the rest pose, never a partial bind.
//   2. Performance, at a realistic combat-encounter NPC-token count, with
//      real WebGL skinning + AnimationMixer cost together, on whatever GPU
//      backend this environment actually provides (logged explicitly —
//      see RENDERER_INFO below — since a GPU-less sandbox falls back to
//      SwiftShader software rendering, which perf-budgets.json's own
//      render3d note already documents as non-representative of real
//      hardware).
//
// Needs no Next.js build or Supabase stack — a tiny static server exposes
// three's module build, three-stdlib's SkeletonUtils, the compiled pose.ts
// module, and the two fixture .glb files to headless Chromium.
//
// Usage: node scripts/perf/posed-npc-benchmark.mjs

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));
const PORT = 3211;
const FRAME_COUNT = 180;
// "A dozen-plus simultaneous NPC/monster tokens" — the design doc's own
// §7/§9 explicit framing of "realistic combat-encounter scale". Split
// between the two authored poses so both get real-GPU coverage in one run.
const INSTANCE_COUNT = 16;

// --- Compile pose.ts to a plain ES module for the browser (this harness
// runs no bundler/Next.js) — tsc alone is sufficient since pose.ts has no
// JSX and its only import (three) is resolved by the importmap below,
// exactly like asset-render-benchmark.mjs's own "three" mapping. ---
const compileDir = mkdtempSync(join(tmpdir(), "posed-npc-pose-"));
try {
  execFileSync(
    join(rootDir, "node_modules", ".bin", "tsc"),
    [
      join(rootDir, "src", "scene-3d", "pose.ts"),
      "--module",
      "es2020",
      "--target",
      "es2020",
      "--moduleResolution",
      "bundler",
      "--declaration",
      "false",
      "--outDir",
      compileDir,
    ],
    { stdio: "inherit" }
  );
} catch (err) {
  rmSync(compileDir, { recursive: true, force: true });
  throw new Error(`failed to compile src/scene-3d/pose.ts for the browser harness: ${err.message}`);
}
const compiledPoseJs = readFileSync(join(compileDir, "pose.js"), "utf8");
rmSync(compileDir, { recursive: true, force: true });

const CONTENT_TYPES = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".glb": "model/gltf-binary",
  ".html": "text/html",
};

const page = /* html */ `<!doctype html>
<html>
  <head>
    <script type="importmap">
      {
        "imports": {
          "three": "/node_modules/three/build/three.module.js",
          "three/examples/jsm/": "/node_modules/three/examples/jsm/",
          "three-stdlib/utils/SkeletonUtils.js": "/node_modules/three-stdlib/utils/SkeletonUtils.js",
          "/pose.js": "/pose.js"
        }
      }
    </script>
  </head>
  <body style="margin:0">
    <script type="module">
      import * as THREE from "three";
      import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
      import { SkeletonUtils } from "three-stdlib/utils/SkeletonUtils.js";
      import { resolvePoseBones, buildPoseClip } from "/pose.js";

      const instanceCount = ${INSTANCE_COUNT};
      const frameCount = ${FRAME_COUNT};

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(1280, 720);
      renderer.shadowMap.enabled = true;
      document.body.appendChild(renderer.domElement);

      // Real render-backend identification — SwiftShader (software) vs a
      // real GPU (ANGLE/Vulkan/Metal/etc). This sandbox is known to lack a
      // usable GPU driver; logging this explicitly means the resulting
      // frame-time number is never silently mistaken for a real-hardware
      // measurement.
      const gl = renderer.getContext();
      const dbgInfo = gl.getExtension("WEBGL_debug_renderer_info");
      const rendererString = dbgInfo
        ? gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0d0520);
      scene.add(new THREE.AmbientLight(0xb9a6ff, 0.55));
      const sun = new THREE.DirectionalLight(0xffe9c9, 3.4);
      sun.position.set(5, 10, 3);
      sun.castShadow = true;
      scene.add(sun);

      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(24, 48),
        new THREE.MeshStandardMaterial({ color: 0x1a1338, roughness: 0.95 })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      scene.add(ground);

      const camera = new THREE.PerspectiveCamera(50, 1280 / 720, 0.1, 100);
      camera.position.set(0, 6, 10);
      camera.lookAt(0, 1, 0);

      const loader = new GLTFLoader();
      function loadGlb(url) {
        return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
      }

      const [figureGltf, simpleGltf] = await Promise.all([
        loadGlb("/public/test-fixtures/RiggedFigure.glb"),
        loadGlb("/public/test-fixtures/RiggedSimple.glb"),
      ]);

      // --- Correctness check 1: the non-conforming skeleton falls back,
      // exactly today's static rendering, never a partial bind. ---
      const simpleResolved = resolvePoseBones(simpleGltf.scene);
      const riggedSimpleFallsBack = simpleResolved === null;

      // --- Correctness check 2 + the actual perf scene: N real animated
      // skinned RiggedFigure instances, half "sitting" half "idle", each
      // independently cloned (SkeletonUtils.clone — exactly what drei's
      // <Clone> already does per rendered instance) and independently
      // mixed. ---
      const figureResolved = resolvePoseBones(figureGltf.scene);
      if (!figureResolved) throw new Error("RiggedFigure.glb unexpectedly failed the pose compatibility check");

      const sittingClip = buildPoseClip("sitting", figureResolved);
      const idleClip = buildPoseClip("idle", figureResolved);
      const restLeftUpperArmQuat = figureResolved.bones.leftUpperArm.quaternion.clone();
      const restLeftUpperLegQuat = figureResolved.bones.leftUpperLeg.quaternion.clone();

      const columns = Math.ceil(Math.sqrt(instanceCount));
      const mixers = [];
      let firstSittingInstance = null;
      let firstIdleInstance = null;
      for (let i = 0; i < instanceCount; i++) {
        const sitting = i % 2 === 0;
        const clone = SkeletonUtils.clone(figureGltf.scene);
        clone.traverse((object) => {
          if (object.isMesh) object.castShadow = true;
        });
        clone.position.set((i % columns) * 1.6 - columns * 0.8, 0, Math.floor(i / columns) * 1.6 - columns * 0.5);
        scene.add(clone);

        const mixer = new THREE.AnimationMixer(clone);
        mixer.clipAction(sitting ? sittingClip : idleClip).play();
        mixers.push(mixer);

        if (sitting && !firstSittingInstance) firstSittingInstance = clone;
        if (!sitting && !firstIdleInstance) firstIdleInstance = clone;
      }

      const frameTimes = [];
      let lastTime = performance.now();
      let frame = 0;
      function tick() {
        const now = performance.now();
        const delta = Math.min((now - lastTime) / 1000, 1 / 30);
        for (const mixer of mixers) mixer.update(delta);

        camera.position.x = Math.sin(frame / 150) * 10;
        camera.position.z = Math.cos(frame / 150) * 10 + 2;
        camera.lookAt(0, 1, 0);
        renderer.render(scene, camera);

        frameTimes.push(now - lastTime);
        lastTime = now;
        frame++;
        if (frame < frameCount) {
          requestAnimationFrame(tick);
        } else {
          const warm = frameTimes.slice(10);
          const avg = warm.reduce((a, b) => a + b, 0) / warm.length;

          const sittingLeftUpperLeg = firstSittingInstance.getObjectByName(figureResolved.bones.leftUpperLeg.name);
          const idleLeftUpperArm = firstIdleInstance.getObjectByName(figureResolved.bones.leftUpperArm.name);

          window.__BENCHMARK_RESULT__ = {
            frameCount,
            instanceCount,
            avgFrameTimeMs: avg,
            rendererString,
            riggedSimpleFallsBack,
            // Real, live, GPU-rendered proof — not just the unit-test-level
            // clip construction — that after N real render frames a
            // "sitting" instance's own leg bone actually deviates from its
            // rest angle (bent), and an "idle" instance's own arm bone
            // actually deviates from its own T-pose-adjacent rest angle
            // (brought down).
            sittingLegAngleFromRestRad: sittingLeftUpperLeg.quaternion.angleTo(restLeftUpperLegQuat),
            idleArmAngleFromRestRad: idleLeftUpperArm.quaternion.angleTo(restLeftUpperArmQuat),
          };
        }
      }
      requestAnimationFrame(tick);
    </script>
  </body>
</html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(page);
  }
  if (url.pathname === "/pose.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(compiledPoseJs);
  }
  const relative = normalize(url.pathname).replace(/^([/\\]|\.\.)+/, "");
  try {
    const body = readFileSync(join(rootDir, relative));
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(relative)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));

// Same GPU flags as asset-render-benchmark.mjs/render-benchmark.mjs — try
// for real GPU rendering via ANGLE/Vulkan where available; falls back to
// SwiftShader (software) otherwise, which the script detects and reports
// explicitly rather than silently.
const browser = await chromium.launch({
  args: ["--use-angle=vulkan", "--ignore-gpu-blocklist", "--enable-gpu"],
});

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

try {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  tab.on("pageerror", (err) => {
    throw new Error(`page error: ${err.message}`);
  });
  await tab.goto(`http://localhost:${PORT}/`);

  const result = await tab
    .waitForFunction(() => window.__BENCHMARK_RESULT__ ?? false, { timeout: 30_000 })
    .then((handle) => handle.jsonValue());

  const screenshotPath = join(rootDir, "scripts", "perf", "posed-npc-benchmark.png");
  await tab.screenshot({ path: screenshotPath });

  console.log(`Renderer backend: ${result.rendererString}`);
  const usingSoftwareRenderer = /swiftshader|llvmpipe|software/i.test(result.rendererString);
  if (usingSoftwareRenderer) {
    console.log(
      "NOTE: software rendering detected (no usable GPU in this environment) — frame-time numbers below are " +
        "NOT representative of real hardware; see perf-budgets.json's own render3d note for the same caveat " +
        "against every other perf script in this repo. Re-run on a GPU-backed machine for a meaningful number."
    );
  }
  console.log(`Screenshot saved to ${screenshotPath}`);
  console.log("");

  console.log(`Posed-NPC render benchmark: ${result.instanceCount} real animated skinned instances (RiggedFigure.glb, ${result.instanceCount / 2} sitting + ${result.instanceCount / 2} idle), ${result.frameCount} frames`);
  console.log(`Average frame time: ${result.avgFrameTimeMs.toFixed(2)} ms`);
  console.log(`Implied fps: ${(1000 / result.avgFrameTimeMs).toFixed(1)}`);

  // --- Correctness (meaningful regardless of render backend) ---
  check(
    "RiggedSimple.glb (non-conforming 2-bone skeleton) falls back — resolvePoseBones returned null",
    result.riggedSimpleFallsBack
  );
  check(
    "a real rendered 'sitting' instance's upper-leg bone is genuinely bent (>0.3 rad from rest) after real playback",
    result.sittingLegAngleFromRestRad > 0.3,
    `angle=${result.sittingLegAngleFromRestRad}`
  );
  check(
    "a real rendered 'idle' instance's upper-arm bone is genuinely brought down (>0.3 rad from rest) after real playback",
    result.idleArmAngleFromRestRad > 0.3,
    `angle=${result.idleArmAngleFromRestRad}`
  );

  // --- Performance against perf-budgets.json — informational-only under
  // software rendering (see the NOTE above), a real gate on real hardware. ---
  const budgetMs = budgets.render3d.maxAvgFrameTimeMs;
  const withinBudget = result.avgFrameTimeMs <= budgetMs;
  if (usingSoftwareRenderer) {
    console.log(
      `INFO  average frame time ${result.avgFrameTimeMs.toFixed(2)} ms vs budget ${budgetMs} ms — not gated (software renderer)`
    );
  } else {
    check(`average frame time is within the render3d budget (${budgetMs} ms)`, withinBudget, `${result.avgFrameTimeMs.toFixed(2)} ms`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll posed-NPC checks passed.");
  }
} finally {
  await browser.close();
  server.close();
}
