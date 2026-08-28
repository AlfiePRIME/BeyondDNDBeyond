import { describe, expect, it, vi } from "vitest";
import {
  ComfyClient,
  ComfyUiGenerationError,
  ComfyUiTimeoutError,
  ComfyUiUnreachableError,
  ComfyUiWorkflowRejectedError,
} from "./comfyClient";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ComfyClient.checkReachable", () => {
  it("resolves when /system_stats responds 200", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ system: {}, devices: [] }));
    const client = new ComfyClient("http://10.10.1.10:8188", { fetch: fetchImpl as unknown as typeof fetch });
    await expect(client.checkReachable()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://10.10.1.10:8188/system_stats",
      expect.objectContaining({ signal: expect.anything() })
    );
  });

  it("throws ComfyUiUnreachableError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    await expect(client.checkReachable()).rejects.toThrow(ComfyUiUnreachableError);
  });

  it("throws ComfyUiUnreachableError when the fetch itself rejects (connection refused)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    await expect(client.checkReachable()).rejects.toThrow(ComfyUiUnreachableError);
  });

  it("uses its OWN short timeout, independent of any generation-wait timeout", async () => {
    // A fetch that never resolves — checkReachable's own AbortController
    // must fire well before any 5-minute generation budget would.
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    const start = Date.now();
    await expect(client.checkReachable(50)).rejects.toThrow(ComfyUiUnreachableError);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("ComfyClient.uploadImage", () => {
  it("posts multipart form data and returns the uploaded filename", async () => {
    const fetchImpl = vi.fn(
      async () => jsonResponse({ name: "map-art-control.png", subfolder: "", type: "input" })
    );
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    const name = await client.uploadImage(Buffer.from([1, 2, 3]), "control.png");
    expect(name).toBe("map-art-control.png");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://example.test/upload/image");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("throws a plain ComfyUiError when the upload is rejected", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad request", { status: 400 }));
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    await expect(client.uploadImage(Buffer.from([1]), "x.png")).rejects.toThrow(/rejected the control image/);
  });
});

describe("ComfyClient.queuePrompt", () => {
  it("returns the prompt_id on success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ prompt_id: "abc-123", number: 1, node_errors: {} }));
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    await expect(client.queuePrompt({ node: {} })).resolves.toBe("abc-123");
  });

  it("throws ComfyUiWorkflowRejectedError when node_errors is non-empty", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ prompt_id: null, node_errors: { unet: { errors: ["bad unet_name"] } } })
    );
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    await expect(client.queuePrompt({ node: {} })).rejects.toThrow(ComfyUiWorkflowRejectedError);
  });

  it("throws ComfyUiWorkflowRejectedError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "bad" }, 400));
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    await expect(client.queuePrompt({ node: {} })).rejects.toThrow(ComfyUiWorkflowRejectedError);
  });
});

describe("ComfyClient.waitForImages", () => {
  it("returns the output images once ComfyUI reports completion", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 2) return jsonResponse({});
      return jsonResponse({
        "prompt-1": {
          status: { status_str: "success", completed: true },
          outputs: { save: { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
        },
      });
    });
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    const images = await client.waitForImages("prompt-1", { intervalMs: 1 });
    expect(images).toEqual([{ filename: "out.png", subfolder: "", type: "output" }]);
  });

  it("throws ComfyUiGenerationError when the run's own status is error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ "prompt-1": { status: { status_str: "error", messages: ["OOM"] } } })
    );
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    await expect(client.waitForImages("prompt-1", { intervalMs: 1 })).rejects.toThrow(ComfyUiGenerationError);
  });

  it("throws ComfyUiGenerationError when completed but no images were produced", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ "prompt-1": { status: { status_str: "success", completed: true }, outputs: {} } })
    );
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    await expect(client.waitForImages("prompt-1", { intervalMs: 1 })).rejects.toThrow(ComfyUiGenerationError);
  });

  it("throws ComfyUiTimeoutError once the deadline passes without completion — distinct from unreachable", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    await expect(
      client.waitForImages("prompt-1", { intervalMs: 5, timeoutMs: 30 })
    ).rejects.toThrow(ComfyUiTimeoutError);
  });
});

describe("ComfyClient.fetchImage", () => {
  it("returns the raw image bytes", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const fetchImpl = vi.fn(async () => new Response(bytes));
    const client = new ComfyClient("http://example.test", { fetch: fetchImpl as unknown as typeof fetch });
    const buffer = await client.fetchImage({ filename: "out.png", subfolder: "", type: "output" });
    expect(buffer).toEqual(Buffer.from(bytes));
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://example.test/view?filename=out.png&subfolder=&type=output");
  });
});
