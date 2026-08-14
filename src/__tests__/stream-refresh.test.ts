import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCached: vi.fn(),
  refresh: vi.fn(),
  refreshCN: vi.fn(),
  authSet: vi.fn(),
}));

// Isolate credential storage: stream.ts reads omp's agent.db through
// getCachedCredentials — the real module would hit the host's real login.
vi.mock("../oauth.js", () => ({
  getCachedCredentials: mocks.getCached,
  refreshQoderToken: mocks.refresh,
  refreshQoderTokenCN: mocks.refreshCN,
}));

// Prevent AuthStorage from writing anywhere real during refresh persistence.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: { create: () => ({ set: mocks.authSet }) },
}));

import { streamQoder } from "../stream.js";

/** Build a single SSE `data:` line carrying a Qoder envelope. */
function sseEnvelope(body: object, statusCodeValue = 200, statusCode = "OK"): string {
  return (
    "data:" +
    JSON.stringify({
      headers: { "Content-Type": ["application/json"] },
      body: JSON.stringify(body),
      statusCodeValue,
      statusCode,
    }) +
    "\n\n"
  );
}

const LOGIN_EXPIRED_SSE = sseEnvelope(
  { code: "105", message: "Login expired", request_id: "r", type: "auth_error" },
  403,
  "Forbidden",
);

const BLOCKED_SSE = sseEnvelope(
  { code: "provider_error", message: "Session blocked", request_id: "r", type: "provider_error" },
  406,
  "Not Acceptable",
);

const DONE_SSE =
  "data:" +
  JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    body: "[DONE]",
    statusCodeValue: 200,
    statusCode: "OK",
  }) +
  "\n\n";

const SUCCESS_SSE =
  sseEnvelope({
    choices: [{ delta: { content: "OK", role: "assistant" }, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
  }) +
  sseEnvelope({
    choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
  }) +
  DONE_SSE;

function makeModel(): Model<Api> {
  return { id: "ultimate", api: "qoder-api" as Api, provider: "qoder" } as Model<Api>;
}

function makeContext(): Context {
  return {
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as unknown as Context;
}

const CREDS = {
  access: "jt-old-token",
  refresh: "pat|pt-abc|jrt-xyz|user-1|machine-1",
  userID: "user-1",
  email: "test@example.com",
  name: "Test",
  machineID: "machine-1",
};

function mockFetchSequential(...bodies: string[]) {
  let call = 0;
  return vi.fn(async () => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call++;
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "done" || ev.type === "error") break;
  }
  return events;
}

describe("streamQoder login-expiry retry", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("refreshes an expired job token (403 Login expired) once and retries, delivering the stream", async () => {
    mocks.getCached.mockReturnValue(CREDS);
    mocks.refresh.mockResolvedValue({ ...CREDS, access: "jt-new-token" });

    const fetchMock = mockFetchSequential(LOGIN_EXPIRED_SSE, SUCCESS_SSE);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "jt-old-token" });
    const events = await consume(stream);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event after the retry").toBeDefined();
    // Event union is not discriminated on `type`; the done event carries the message.
    const doneEvent = done as { message: AssistantMessage };
    const msg = doneEvent.message;
    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
  });

  it("surfaces Login expired without retrying when refresh cannot produce a new token", async () => {
    mocks.getCached.mockReturnValue(CREDS);
    // oauth.ts falls back to "extend validity" with the SAME access token on
    // refresh failure — refreshAndPersist must treat that as a failed refresh.
    mocks.refresh.mockResolvedValue({ ...CREDS, access: "jt-old-token" });

    const fetchMock = mockFetchSequential(LOGIN_EXPIRED_SSE);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "jt-old-token" });
    const events = await consume(stream);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event").toBeDefined();
    // Event union is not discriminated on `type`; the error event carries the message.
    const errorEvent = err as { error: AssistantMessage };
    expect(errorEvent.error.errorMessage).toMatch(/Login expired/);
    expect(events.find((e) => e.type === "done")).toBeUndefined();
  });

  it("does not refresh for non-login upstream errors", async () => {
    mocks.getCached.mockReturnValue(CREDS);

    const fetchMock = mockFetchSequential(BLOCKED_SSE);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "jt-old-token" });
    const events = await consume(stream);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();

    const err = events.find((e) => e.type === "error");
    const errorEvent = err as { error: AssistantMessage };
    expect(errorEvent.error.errorMessage).toMatch(/Session blocked/);
  });

  it("does not refresh when no cached credentials are available", async () => {
    mocks.getCached.mockReturnValue(null);

    const fetchMock = mockFetchSequential(LOGIN_EXPIRED_SSE);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "jt-old-token" });
    const events = await consume(stream);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();

    const err = events.find((e) => e.type === "error");
    const errorEvent = err as { error: AssistantMessage };
    expect(errorEvent.error.errorMessage).toMatch(/Login expired/);
  });
});
