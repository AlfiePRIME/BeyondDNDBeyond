// Thin wrapper around the real ComfyUI HTTP API this spike validated live
// against http://10.10.1.10:8188 (a real RTX 4060 Ti instance, ComfyUI
// 0.34.0) — see docs/map-art-generation-research.md for the full write-up.
// Every endpoint here was actually exercised, not inferred from docs:
//   POST /upload/image   multipart 'image' file (+optional 'overwrite')
//                        -> { name, subfolder, type } — the name to
//                        reference from a LoadImage node's `image` input.
//   POST /prompt         JSON { prompt: <graph>, client_id }
//                        -> { prompt_id, number, node_errors }
//   GET  /history/:id    -> {} while queued/running; once done, an object
//                        keyed by prompt_id with .status.completed and
//                        .outputs[nodeId].images[] (each an
//                        { filename, subfolder, type } /view descriptor).
//   GET  /view?filename=&subfolder=&type=  -> raw image bytes.
//   GET  /system_stats, /models, /models/:folder, /object_info(/:class)
//                        -> introspection used to discover what's actually
//                        installed (see the research doc's "what's on the
//                        instance" section) rather than assumed.
//
// No websocket usage here: this PoC polls /history on a fixed interval
// instead, since a one-shot script doesn't need live per-step progress —
// simpler, and just as real an integration as the websocket path ComfyUI's
// own web UI uses for live previews.

const DEFAULT_BASE_URL = process.env.COMFYUI_URL ?? "http://10.10.1.10:8188";

export class ComfyClient {
  constructor(baseUrl = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async systemStats() {
    const res = await fetch(`${this.baseUrl}/system_stats`);
    if (!res.ok) throw new Error(`system_stats failed: ${res.status}`);
    return res.json();
  }

  async listModelFiles(folder) {
    const res = await fetch(`${this.baseUrl}/models/${folder}`);
    if (!res.ok) throw new Error(`models/${folder} failed: ${res.status}`);
    return res.json();
  }

  /** Uploads a PNG buffer as a ComfyUI "input" image; returns the filename
   * a LoadImage node's `image` field should reference. */
  async uploadImage(pngBuffer, filename) {
    const form = new FormData();
    form.append("image", new Blob([pngBuffer], { type: "image/png" }), filename);
    form.append("overwrite", "true");
    const res = await fetch(`${this.baseUrl}/upload/image`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`upload/image failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    return body.name;
  }

  /** Queues a workflow graph (API-format JSON: nodeId -> {class_type,
   * inputs}). Throws with ComfyUI's own node_errors detail if the graph is
   * rejected outright (bad node/input names) rather than merely failing
   * mid-run. */
  async queuePrompt(graph, clientId = "map-art-poc") {
    const res = await fetch(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    });
    const body = await res.json();
    if (!res.ok || (body.node_errors && Object.keys(body.node_errors).length > 0)) {
      throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(body)}`);
    }
    return body.prompt_id;
  }

  /**
   * Polls GET /history/:id on a fixed interval, in the foreground, until
   * ComfyUI reports the job done or `timeoutMs` elapses — a synchronous
   * wait inside this one process, not a detached/background job. Returns
   * the { filename, subfolder, type } descriptor(s) for every image the
   * graph's output node(s) produced.
   */
  async waitForImages(promptId, { intervalMs = 3000, timeoutMs = 300000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await fetch(`${this.baseUrl}/history/${promptId}`);
      if (!res.ok) throw new Error(`history failed: ${res.status}`);
      const body = await res.json();
      const entry = body[promptId];
      if (entry) {
        const status = entry.status?.status_str;
        if (status === "error") {
          throw new Error(`ComfyUI run failed: ${JSON.stringify(entry.status)}`);
        }
        if (entry.status?.completed) {
          const images = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
          if (images.length === 0) throw new Error("Run completed but produced no images.");
          return images;
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for prompt ${promptId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async fetchImage({ filename, subfolder = "", type = "output" }) {
    const params = new URLSearchParams({ filename, subfolder, type });
    const res = await fetch(`${this.baseUrl}/view?${params}`);
    if (!res.ok) throw new Error(`view failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Convenience: queue + wait + fetch the first output image. */
  async runToImage(graph, options) {
    const promptId = await this.queuePrompt(graph, options?.clientId);
    const images = await this.waitForImages(promptId, options);
    return this.fetchImage(images[0]);
  }
}
