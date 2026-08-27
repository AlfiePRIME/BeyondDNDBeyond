// Chat & Summary B6 verification helper: a tiny local double for the
// Anthropic Messages API. The real generateSessionSummary (src/ai) talks to
// the Anthropic SDK's default client construction with no injected fetch —
// its ONLY seam for an end-to-end (real HTTP, real server process) run is
// the SDK's own ANTHROPIC_BASE_URL env var honor (confirmed directly against
// node_modules/@anthropic-ai/sdk/client.js), exactly the mechanism this
// project's own src/ai/README.md already documents as the intended
// end-to-end testing path ("an end-to-end run can point the server at a
// local fake"). No prior prompt in this project actually built that
// harness — B6 is the first AI-generation feature whose Playwright
// acceptance criteria requires a REAL model call to reflect REAL seeded
// content, so this is new.
//
// Usage: the caller supplies `buildResponse(requestBody)` — given the exact
// JSON body the SDK sent (system prompt, messages, tools, tool_choice), it
// returns the tool_use `input` object to send back (record_session_summary's
// {narrative, highlights} shape). The caller decides what to echo back
// (typically by scanning the request's transcript text for known markers it
// seeded), keeping this module itself scenario-agnostic.
import http from "node:http";

export async function startFakeAnthropicServer(buildResponse) {
  let lastRequestBody = null;
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/_debug/last-request") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ requestCount, lastRequestBody }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/messages") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = null;
        }
        requestCount += 1;
        lastRequestBody = body;

        const toolName = body?.tool_choice?.name ?? body?.tools?.[0]?.name ?? "record_session_summary";
        const input = buildResponse(body);
        const message = {
          id: `msg_fake_${requestCount}`,
          type: "message",
          role: "assistant",
          model: body?.model ?? "claude-sonnet-5",
          content: [{ type: "tool_use", id: `toolu_fake_${requestCount}`, name: toolName, input }],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50 },
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no such route on the fake" } }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    getRequestCount: () => requestCount,
    getLastRequestBody: () => lastRequestBody,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
