import { describe, expect, it, vi } from "vitest";
import { generateMapArt } from "./generateMapArt";
import { ComfyUiTimeoutError, ComfyUiUnreachableError } from "./comfyClient";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake ComfyUI server that plays along with the whole
 * reachable→upload→queue→poll→fetch sequence generateMapArt drives —
 * mirrors generateMapArea.test.ts's own fakeTransport shape (this
 * codebase's established injectable-fetch testing seam), applied to
 * ComfyUI's multi-endpoint sequence instead of a single completion call. */
function fakeComfyUi() {
  const requests: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/system_stats")) return jsonResponse({ system: {}, devices: [] });
    if (url.endsWith("/upload/image")) return jsonResponse({ name: "map-art-control.png" });
    if (url.endsWith("/prompt")) return jsonResponse({ prompt_id: "prompt-1", node_errors: {} });
    if (url.includes("/history/")) {
      return jsonResponse({
        "prompt-1": {
          status: { status_str: "success", completed: true },
          outputs: { save: { images: [{ filename: "result.png", subfolder: "", type: "output" }] } },
        },
      });
    }
    if (url.includes("/view?")) return new Response(new Uint8Array([1, 2, 3, 4]));
    throw new Error(`unexpected URL in fake ComfyUI: ${url}`);
  });
  return { fetch: fetchImpl as unknown as typeof fetch, requests };
}

describe("generateMapArt", () => {
  it("drives the full reachable→upload→queue→poll→fetch sequence and returns the PNG", async () => {
    const { fetch: transport, requests } = fakeComfyUi();
    const result = await generateMapArt(
      {
        hostUrl: "http://10.10.1.10:8188",
        controlImagePng: Buffer.from([9, 9, 9]),
        width: 1024,
        height: 1024,
        prompt: "a stone dungeon room",
      },
      { fetch: transport }
    );
    expect(result.png).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(requests.some((url) => url.endsWith("/system_stats"))).toBe(true);
    expect(requests.some((url) => url.endsWith("/upload/image"))).toBe(true);
    expect(requests.some((url) => url.endsWith("/prompt"))).toBe(true);
  });

  it("never reaches the upload/queue steps when the host is unreachable", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      generateMapArt(
        {
          hostUrl: "http://example.test",
          controlImagePng: Buffer.from([1]),
          width: 512,
          height: 512,
          prompt: "x",
        },
        { fetch: fetchImpl as unknown as typeof fetch }
      )
    ).rejects.toThrow(ComfyUiUnreachableError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates a timeout distinctly from an unreachable host", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/system_stats")) return jsonResponse({ system: {}, devices: [] });
      if (url.endsWith("/upload/image")) return jsonResponse({ name: "control.png" });
      if (url.endsWith("/prompt")) return jsonResponse({ prompt_id: "prompt-1", node_errors: {} });
      if (url.includes("/history/")) return jsonResponse({}); // never completes
      throw new Error(`unexpected URL: ${url}`);
    });
    await expect(
      generateMapArt(
        {
          hostUrl: "http://example.test",
          controlImagePng: Buffer.from([1]),
          width: 512,
          height: 512,
          prompt: "x",
          timeoutMs: 30,
        },
        { fetch: fetchImpl as unknown as typeof fetch }
      )
    ).rejects.toThrow(ComfyUiTimeoutError);
  });

  it("uses a fresh random seed per call rather than a fixed one — a DM retrying should not get a byte-identical image", async () => {
    const seeds: number[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/system_stats")) return jsonResponse({ system: {}, devices: [] });
      if (url.endsWith("/upload/image")) return jsonResponse({ name: "control.png" });
      if (url.endsWith("/prompt")) {
        const graph = JSON.parse(String(init?.body)).prompt as Record<string, { inputs: Record<string, unknown> }>;
        seeds.push(graph.noise.inputs.noise_seed as number);
        return jsonResponse({ prompt_id: "prompt-1", node_errors: {} });
      }
      if (url.includes("/history/")) {
        return jsonResponse({
          "prompt-1": {
            status: { status_str: "success", completed: true },
            outputs: { save: { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
          },
        });
      }
      if (url.includes("/view?")) return new Response(new Uint8Array([1]));
      throw new Error(`unexpected URL: ${url}`);
    });
    const run = () =>
      generateMapArt(
        { hostUrl: "http://example.test", controlImagePng: Buffer.from([1]), width: 512, height: 512, prompt: "x" },
        { fetch: fetchImpl as unknown as typeof fetch }
      );
    await run();
    await run();
    expect(seeds).toHaveLength(2);
    expect(seeds[0]).not.toBe(seeds[1]);
  });
});
