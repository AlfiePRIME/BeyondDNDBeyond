// Thin wrapper around the real ComfyUI HTTP API — the ONLY file in this
// module (and the only file in this whole app) that may construct a request
// against a ComfyUI host. Ported from the Map Art Generation E1 research
// spike's own scripts/poc/map-art-generation/comfyClient.mjs (see
// docs/map-art-generation-research.md §3), which validated every one of
// these endpoints live against http://10.10.1.10:8188. Two behavioral
// additions over the PoC, both real production requirements the PoC (a
// one-shot script a human just watches) never needed:
//   1. An injectable `fetch` transport — this codebase's established seam
//      (see generateDraft.ts/generateMapArea.ts in @/ai) so a real
//      generation's request/response handling can be exercised in a unit
//      test with a canned response, without a live network call.
//   2. AbortController-based per-call timeouts, and — critically — TWO
//      separate timeout budgets rather than one: a short one for "is the
//      host even there" (checkReachable) and a long one for "is the
//      generation itself still running" (waitForImages). E1's own timing
//      data (§8) shows real generations taking 79-120s on the validated
//      hardware; reusing a short reachability timeout for that wait would
//      make every real generation look like a hang, and reusing the long
//      generation timeout for reachability would make a genuinely
//      unreachable host take minutes to report as such instead of seconds.
export interface ComfyClientOptions {
  fetch?: typeof fetch;
}

export class ComfyUiError extends Error {}

/** The host didn't answer at all within checkReachable's own short timeout
 * (network failure, connection refused, or no response in time) — distinct
 * from a slow-but-running generation, which is ComfyUiTimeoutError below. */
export class ComfyUiUnreachableError extends ComfyUiError {}

/** ComfyUI's own POST /prompt rejected the workflow graph outright
 * (non-empty node_errors) — a malformed graph, not a mid-run failure. */
export class ComfyUiWorkflowRejectedError extends ComfyUiError {}

/** The queued run itself reported status "error" (e.g. a model failed to
 * load, an OOM mid-sampling), or completed with no output images — the graph
 * was accepted but execution failed. */
export class ComfyUiGenerationError extends ComfyUiError {}

/** The run never completed within the generation-wait timeout. NOT the same
 * as unreachable: the host answered every poll, the job just didn't finish
 * (or ComfyUI queued it behind other work) before the deadline. */
export class ComfyUiTimeoutError extends ComfyUiError {}

/** Real generations on the E1-validated hardware took 79-120s (research doc
 * §8); 5 minutes leaves real headroom for a slower/queued run without
 * masking a genuinely stuck job forever. NEVER reuse this for
 * checkReachable's own short timeout, or vice versa — see this file's own
 * header comment. */
export const DEFAULT_GENERATION_TIMEOUT_MS = 300_000;

const DEFAULT_REACHABILITY_TIMEOUT_MS = 8_000;

interface ViewDescriptor {
  filename: string;
  subfolder: string;
  type: string;
}

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
  outputs?: Record<string, { images?: ViewDescriptor[] }>;
}

async function withTimeout<T>(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  run: (fetchWithSignal: typeof fetch) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signalled: typeof fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetchImpl(input, { ...init, signal: controller.signal })) as typeof fetch;
  try {
    return await run(signalled);
  } finally {
    clearTimeout(timer);
  }
}

export class ComfyClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, options: ComfyClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * A fast health check (GET /system_stats) with its OWN short timeout,
   * deliberately separate from waitForImages' generation-wait timeout — see
   * this file's own header comment. Throws ComfyUiUnreachableError (with the
   * host URL in the message, so a DM sees something actionable) on any
   * failure: connection refused, DNS failure, non-2xx response, or no
   * response within `timeoutMs`.
   */
  async checkReachable(timeoutMs = DEFAULT_REACHABILITY_TIMEOUT_MS): Promise<void> {
    let res: Response;
    try {
      res = await withTimeout(this.fetchImpl, timeoutMs, (f) => f(`${this.baseUrl}/system_stats`));
    } catch (err) {
      throw new ComfyUiUnreachableError(
        `Could not reach the ComfyUI host at ${this.baseUrl} within ${timeoutMs}ms: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (!res.ok) {
      throw new ComfyUiUnreachableError(`ComfyUI host ${this.baseUrl} responded with HTTP ${res.status}.`);
    }
  }

  /** Uploads a PNG buffer as a ComfyUI "input" image; returns the filename a
   * LoadImage node's `image` field should reference. */
  async uploadImage(pngBuffer: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(pngBuffer)], { type: "image/png" }), filename);
    form.append("overwrite", "true");
    const res = await this.fetchImpl(`${this.baseUrl}/upload/image`, { method: "POST", body: form });
    if (!res.ok) {
      throw new ComfyUiError(`ComfyUI rejected the control image upload: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { name: string };
    return body.name;
  }

  /** Queues a workflow graph (API-format JSON: nodeId -> {class_type,
   * inputs}). Throws ComfyUiWorkflowRejectedError with ComfyUI's own
   * node_errors detail if the graph is rejected outright — distinct from a
   * mid-run failure (ComfyUiGenerationError, from waitForImages below). */
  async queuePrompt(graph: Record<string, unknown>, clientId = "map-art"): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      prompt_id?: string;
      node_errors?: Record<string, unknown>;
    };
    if (!res.ok || (body.node_errors && Object.keys(body.node_errors).length > 0)) {
      throw new ComfyUiWorkflowRejectedError(`ComfyUI rejected the workflow: ${JSON.stringify(body)}`);
    }
    if (!body.prompt_id) {
      throw new ComfyUiError("ComfyUI accepted the workflow but returned no prompt_id.");
    }
    return body.prompt_id;
  }

  /**
   * Polls GET /history/:id on a fixed interval, in the foreground, until
   * ComfyUI reports the job done or `timeoutMs` elapses — a synchronous wait
   * inside this one request, not a detached/background job (this project's
   * own no-background-polling convention, applied here to a real
   * multi-minute wait rather than assumed away). `timeoutMs` defaults to
   * DEFAULT_GENERATION_TIMEOUT_MS.
   */
  async waitForImages(
    promptId: string,
    { intervalMs = 3000, timeoutMs = DEFAULT_GENERATION_TIMEOUT_MS }: { intervalMs?: number; timeoutMs?: number } = {}
  ): Promise<ViewDescriptor[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.fetchImpl(`${this.baseUrl}/history/${promptId}`);
      if (!res.ok) throw new ComfyUiError(`ComfyUI /history request failed: ${res.status}`);
      const body = (await res.json()) as Record<string, HistoryEntry>;
      const entry = body[promptId];
      if (entry) {
        if (entry.status?.status_str === "error") {
          throw new ComfyUiGenerationError(`ComfyUI run failed: ${JSON.stringify(entry.status)}`);
        }
        if (entry.status?.completed) {
          const images = Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? []);
          if (images.length === 0) {
            throw new ComfyUiGenerationError("ComfyUI run completed but produced no images.");
          }
          return images;
        }
      }
      if (Date.now() > deadline) {
        throw new ComfyUiTimeoutError(
          `Map art generation did not complete within ${Math.round(timeoutMs / 1000)}s.`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async fetchImage(descriptor: ViewDescriptor): Promise<Buffer> {
    const params = new URLSearchParams({
      filename: descriptor.filename,
      subfolder: descriptor.subfolder ?? "",
      type: descriptor.type ?? "output",
    });
    const res = await this.fetchImpl(`${this.baseUrl}/view?${params}`);
    if (!res.ok) throw new ComfyUiError(`ComfyUI /view request failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
