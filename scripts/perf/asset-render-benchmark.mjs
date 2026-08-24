#!/usr/bin/env node
// Map-asset render benchmark (Prompt 24). The Game Room doesn't render map
// objects yet (that UI is Prompts 26-29), so the main render-benchmark.mjs
// can't exercise these assets — this loads every generated preset .glb into
// a headless Three.js scene, places several instances of each, and checks
// average frame time against the same render3d budget. Re-point map-object
// perf checks at the real Game Room scene once it renders placed objects.
//
// Needs no Next.js build or Supabase stack — a tiny static server exposes
// three's module build and the .glb files to headless Chromium.
//
// Usage: node scripts/perf/asset-render-benchmark.mjs

import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));
const PORT = 3210;
const FRAME_COUNT = 180;
const INSTANCES_PER_ASSET = 3;

const assetFiles = readdirSync(join(rootDir, "public", "assets", "presets")).filter((f) => f.endsWith(".glb"));
if (assetFiles.length === 0) {
  throw new Error("no preset .glb files found — run scripts/assets/generate-map-presets.mjs first");
}

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
          "three/examples/jsm/": "/node_modules/three/examples/jsm/"
        }
      }
    </script>
  </head>
  <body style="margin:0">
    <script type="module">
      import * as THREE from "three";
      import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

      const assetFiles = ${JSON.stringify(assetFiles)};
      const instancesPerAsset = ${INSTANCES_PER_ASSET};
      const frameCount = ${FRAME_COUNT};

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(1280, 720);
      renderer.shadowMap.enabled = true;
      document.body.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0d0520);

      // Same lighting shape as GameTableScene (ambient + shadow-casting
      // directional) so material cost is measured under realistic conditions.
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
      camera.position.set(0, 7, 9);
      camera.lookAt(0, 0.5, 0);

      const loader = new GLTFLoader();
      const models = await Promise.all(
        assetFiles.map(
          (file) =>
            new Promise((resolve, reject) =>
              loader.load("/public/assets/presets/" + file, resolve, undefined, reject)
            )
        )
      );

      const total = assetFiles.length * instancesPerAsset;
      const columns = Math.ceil(Math.sqrt(total));
      models.forEach((gltf, assetIndex) => {
        for (let i = 0; i < instancesPerAsset; i++) {
          const clone = gltf.scene.clone(true);
          const slot = assetIndex * instancesPerAsset + i;
          clone.position.set((slot % columns) * 2 - columns, 0, Math.floor(slot / columns) * 2 - columns / 2);
          clone.traverse((object) => {
            if (object.isMesh) object.castShadow = true;
          });
          scene.add(clone);
        }
      });

      const frameTimes = [];
      let lastTime = performance.now();
      let frame = 0;
      function tick() {
        // A slow orbit keeps the scene from being a static (trivially
        // cached) frame.
        camera.position.x = Math.sin(frame / 120) * 9;
        camera.position.z = Math.cos(frame / 120) * 9;
        camera.lookAt(0, 0.5, 0);
        renderer.render(scene, camera);

        const now = performance.now();
        frameTimes.push(now - lastTime);
        lastTime = now;
        frame++;
        if (frame < frameCount) {
          requestAnimationFrame(tick);
        } else {
          const warm = frameTimes.slice(5);
          const avg = warm.reduce((a, b) => a + b, 0) / warm.length;
          window.__BENCHMARK_RESULT__ = { frameCount, objectCount: total, avgFrameTimeMs: avg };
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

// Same GPU flags as render-benchmark.mjs, for the same reason: measure real
// GPU rendering via ANGLE/Vulkan where available, not SwiftShader.
const browser = await chromium.launch({
  args: ["--use-angle=vulkan", "--ignore-gpu-blocklist", "--enable-gpu"],
});

try {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  tab.on("pageerror", (err) => {
    throw new Error(`page error: ${err.message}`);
  });
  await tab.goto(`http://localhost:${PORT}/`);

  const result = await tab
    .waitForFunction(() => window.__BENCHMARK_RESULT__ ?? false, { timeout: 30_000 })
    .then((handle) => handle.jsonValue());

  const budgetMs = budgets.render3d.maxAvgFrameTimeMs;
  console.log(
    `Map-asset render benchmark: ${result.objectCount} placed objects (${assetFiles.length} assets x ${INSTANCES_PER_ASSET}), ${result.frameCount} frames`
  );
  console.log(`Average frame time: ${result.avgFrameTimeMs.toFixed(2)} ms (budget: ${budgetMs} ms)`);
  console.log(`Implied fps: ${(1000 / result.avgFrameTimeMs).toFixed(1)}`);

  if (result.avgFrameTimeMs > budgetMs) {
    console.error(`FAIL: average frame time ${result.avgFrameTimeMs.toFixed(2)} ms exceeds budget ${budgetMs} ms.`);
    process.exitCode = 1;
  } else {
    console.log("PASS");
  }
} finally {
  await browser.close();
  server.close();
}
