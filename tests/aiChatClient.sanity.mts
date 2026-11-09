/*
 * Sanity checks for the AI chat client's endpoint handling.
 *
 * Run: node --experimental-strip-types tests/aiChatClient.sanity.mts
 */
import { strict as assert } from "node:assert";

import {
  chatCompletionsUrl,
  createChatCompletion,
  isAzureEndpoint,
  isLocalEndpoint,
  streamChatCompletion,
} from "../src/extensions/ai-chat/client.ts";

assert.equal(
  chatCompletionsUrl("https://api.openai.com/v1"),
  "https://api.openai.com/v1/chat/completions",
);

assert.equal(
  chatCompletionsUrl("https://openrouter.ai/api/v1/"),
  "https://openrouter.ai/api/v1/chat/completions",
);

assert.equal(
  chatCompletionsUrl("https://example.test/v1/chat/completions"),
  "https://example.test/v1/chat/completions",
);

assert.equal(
  chatCompletionsUrl(
    "https://resource.openai.azure.com/openai/deployments/my-deployment",
    "2024-10-21",
  ),
  "https://resource.openai.azure.com/openai/deployments/my-deployment/chat/completions?api-version=2024-10-21",
);

assert.equal(
  chatCompletionsUrl("https://proxy.test/v1?tenant=demo", "2024-10-21"),
  "https://proxy.test/v1/chat/completions?tenant=demo&api-version=2024-10-21",
);

assert.equal(
  chatCompletionsUrl("https://proxy.test/v1?api-version=1"),
  "https://proxy.test/v1/chat/completions?api-version=1",
);

assert.throws(() => chatCompletionsUrl("   "));

assert.equal(isLocalEndpoint("http://localhost:11434/v1"), true);
assert.equal(isLocalEndpoint("http://127.0.0.1:1234/v1"), true);
assert.equal(isLocalEndpoint("https://api.openai.com/v1"), false);

assert.equal(isAzureEndpoint("https://resource.openai.azure.com/openai/deployments/x", ""), true);
assert.equal(isAzureEndpoint("https://api.openai.com/v1", "2024-10-21"), true);
assert.equal(isAzureEndpoint("https://api.openai.com/v1", ""), false);

const originalFetch = globalThis.fetch;
const completionPayload = JSON.stringify({
  choices: [
    {
      message: {
        role: "assistant",
        content: "ok",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.txt"}' },
          },
        ],
      },
    },
  ],
});

try {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;

    return new Response(completionPayload, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const message = await createChatCompletion({
    baseUrl: "https://api.example/v1",
    apiKey: "secret",
    proxyUrl: "https://proxy.example/flow",
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });

  assert.equal(capturedUrl, "https://proxy.example/flow");
  assert.equal(message.content, "ok");
  assert.equal(message.tool_calls?.[0]?.function.name, "read_file");

  const envelope = JSON.parse(String(capturedInit?.body)) as {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };
  const forwardedBody = JSON.parse(envelope.body) as {
    stream: boolean;
    tools?: unknown[];
  };

  assert.equal(envelope.url, "https://api.example/v1/chat/completions");
  assert.equal(envelope.method, "POST");
  assert.equal(envelope.headers.authorization, "Bearer secret");
  assert.equal(envelope.headers.origin, undefined);
  assert.equal(forwardedBody.stream, false);
  assert.equal(forwardedBody.tools?.length, 1);

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { role: "assistant", content: "wrapped" } }],
        }),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const wrapped = await createChatCompletion({
    baseUrl: "https://api.example/v1",
    apiKey: "secret",
    proxyUrl: "https://proxy.example/flow",
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(wrapped.content, "wrapped");

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        status: 401,
        body: '{"error":{"message":"bad key"}}',
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  await assert.rejects(
    () =>
      createChatCompletion({
        baseUrl: "https://api.example/v1",
        apiKey: "secret",
        proxyUrl: "https://proxy.example/flow",
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    /bad key/,
  );

  const deltas: string[] = [];

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "streamed" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  await streamChatCompletion({
    baseUrl: "https://api.example/v1",
    apiKey: "secret",
    proxyUrl: "https://proxy.example/flow",
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    onDelta: (delta) => deltas.push(delta),
  });

  assert.deepEqual(deltas, ["streamed"]);
} finally {
  globalThis.fetch = originalFetch;
}

console.info("aiChatClient sanity checks passed.");
