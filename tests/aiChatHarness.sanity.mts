/*
 * Sanity checks for the AI chat agent loop.
 *
 * Run: node --experimental-strip-types tests/aiChatHarness.sanity.mts
 */
import { strict as assert } from "node:assert";

import { runAgent, type AgentEvent } from "../src/extensions/ai-chat/harness.ts";
import {
  globToRegExp,
  isGlobPattern,
  matchesFindPattern,
} from "../src/extensions/ai-chat/globMatch.ts";
import { createSession, titleFromPrompt } from "../src/extensions/ai-chat/types.ts";

assert.equal(titleFromPrompt("  Summarize   this workspace  "), "Summarize this workspace");
assert.equal(titleFromPrompt(""), "New chat");
assert.equal(createSession("file:///demo").workspace, "file:///demo");

// find_files semantics: plain text matches paths and basenames; globs can span
// directories.
assert.ok(matchesFindPattern(undefined, "App.tsx", "src/App.tsx"));
assert.ok(matchesFindPattern(undefined, "app", "src/App.tsx"));
assert.ok(matchesFindPattern(globToRegExp("*.tsx"), "*.tsx", "src/App.tsx"));
assert.ok(matchesFindPattern(globToRegExp("**/*.tsx"), "**/*.tsx", "App.tsx"));
assert.ok(matchesFindPattern(globToRegExp("src/**"), "src/**", "src/components/App.tsx"));
assert.ok(!matchesFindPattern(globToRegExp("**/*.css"), "**/*.css", "src/App.tsx"));
assert.ok(isGlobPattern("**/*.tsx"));
assert.ok(!isGlobPattern("App.tsx"));

const tools = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

type RecordedRequest = {
  model?: string;
  messages?: { role: string; content?: string; tool_call_id?: string }[];
  tools?: unknown[];
};

const requests: RecordedRequest[] = [];
const events: AgentEvent[] = [];
const executed: string[] = [];

const result = await runAgent({
  settings: {
    baseUrl: "https://example.test/v1",
    apiVersion: "",
    proxyUrl: "",
    model: "test-model",
    systemPrompt: "You are a test agent.",
    maxTokens: 128,
    temperature: 0,
    enableWorkspaceTools: true,
    maxAgentSteps: 5,
  },
  apiKey: "test-key",
  turns: [],
  prompt: "Check src/index.ts",
  tools,
  toolPrompt: "Use tools.",
  signal: new AbortController().signal,
  executeTool: async (call) => {
    executed.push(call.function.name);

    return {
      content: JSON.stringify({ path: "src/index.ts", content: "export {};" }),
      ok: true,
      summary: "Read src/index.ts",
    };
  },
  onEvent: (event) => events.push(event),
  streamCompletion: async () => {
    throw new Error("streaming path should not be used while tools are enabled");
  },
  runCompletion: async (options) => {
    requests.push(options as unknown as RecordedRequest);

    if (requests.length === 1) {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "src/index.ts" }),
            },
          },
        ],
      };
    }

    return { role: "assistant", content: "The file is fine." };
  },
});

assert.equal(result.incomplete, undefined);
assert.deepEqual(executed, ["read_file"]);
assert.equal(requests.length, 2);
assert.ok(Array.isArray(requests[0].tools) && requests[0].tools.length > 0);
assert.ok(
  requests[1].messages?.some(
    (message) => message.role === "tool" && message.tool_call_id === "call-1",
  ),
  "second request should include the tool result",
);

assert.ok(events.some((event) => event.type === "tool-start"));
assert.ok(events.some((event) => event.type === "tool-end" && event.result.ok));
assert.ok(
  events.some((event) => event.type === "delta" && event.text.includes("The file is fine.")),
);

console.log("aiChatHarness sanity checks passed.");
