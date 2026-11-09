import type {
  ChatCompletionOptions,
  OpenAiAssistantMessage,
  OpenAiChatMessage,
  OpenAiRequestMessage,
  OpenAiToolCall,
  OpenAiToolDefinition,
  StreamChatOptions,
} from "./client.js";
import type { ToolResult } from "./tools.js";

/*
 * The agent loop. This module has no VS Code dependencies and receives the
 * completion functions from the caller, which keeps it easy to test and lets
 * the UI own rendering.
 */

export type CompletionFunction = (
  options: ChatCompletionOptions,
) => Promise<OpenAiAssistantMessage>;

export type StreamFunction = (options: StreamChatOptions) => Promise<void>;

export type AgentTurn = {
  role: "user" | "assistant";
  text: string;
};

export type AgentSettings = {
  baseUrl: string;
  apiVersion: string;
  proxyUrl: string;
  model: string;
  systemPrompt: string;
  environmentContext?: string;
  /** Workspace root URI, included in the environment block. */
  workspaceRoot?: string;
  maxTokens: number;
  temperature: number;
  enableWorkspaceTools: boolean;
  maxAgentSteps: number;
};

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool-start"; call: OpenAiToolCall }
  | { type: "tool-end"; call: OpenAiToolCall; result: ToolResult };

export type AgentRunnerOptions = {
  settings: AgentSettings;
  apiKey: string;
  turns: AgentTurn[];
  prompt: string;
  tools: OpenAiToolDefinition[];
  toolPrompt: string;
  executeTool: (call: OpenAiToolCall) => Promise<ToolResult>;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  onLog?: (line: string) => void;
  /** Injected so tests can supply a deterministic completion implementation. */
  runCompletion: CompletionFunction;
  streamCompletion: StreamFunction;
};

export type AgentRunResult = {
  /** Set when the loop hit maxAgentSteps without a final answer. */
  incomplete?: string;
};

function systemPromptFor(options: AgentRunnerOptions): string {
  const environment = [
    options.settings.workspaceRoot != null
      ? `Workspace root: ${options.settings.workspaceRoot}`
      : "",
    options.settings.environmentContext ?? "",
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");

  return [
    options.settings.systemPrompt,
    environment.length > 0 ? `Environment:\n${environment}` : "",
    options.settings.enableWorkspaceTools ? options.toolPrompt : "",
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function baseMessages(options: AgentRunnerOptions): OpenAiChatMessage[] {
  const messages: OpenAiChatMessage[] = [];
  const systemPrompt = systemPromptFor(options);

  if (systemPrompt.length > 0) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const turn of options.turns) {
    if (turn.text.trim().length > 0) {
      messages.push({ role: turn.role, content: turn.text });
    }
  }

  messages.push({ role: "user", content: options.prompt });

  return messages;
}

export async function runAgent(options: AgentRunnerOptions): Promise<AgentRunResult> {
  const toolsEnabled = options.settings.enableWorkspaceTools && options.tools.length > 0;

  if (!toolsEnabled) {
    options.onEvent({ type: "status", text: "Thinking…" });

    await options.streamCompletion({
      baseUrl: options.settings.baseUrl,
      apiVersion: options.settings.apiVersion,
      proxyUrl: options.settings.proxyUrl,
      apiKey: options.apiKey,
      model: options.settings.model,
      messages: baseMessages(options),
      temperature: options.settings.temperature,
      maxTokens: options.settings.maxTokens,
      signal: options.signal,
      onDelta(delta) {
        if (delta.length > 0) {
          options.onEvent({ type: "delta", text: delta });
        }
      },
    });

    return {};
  }

  const messages: OpenAiRequestMessage[] = baseMessages(options);
  let wroteText = false;

  for (let step = 0; step < options.settings.maxAgentSteps; step += 1) {
    if (options.signal.aborted) {
      return {};
    }

    options.onEvent({ type: "status", text: step === 0 ? "Thinking…" : "Continuing…" });
    options.onLog?.(
      `[ai-chat] POST ${options.settings.proxyUrl.trim() ? "via proxy" : options.settings.baseUrl} ` +
        `(model=${options.settings.model}, step=${step + 1}, messages=${messages.length}).`,
    );

    const message = await options.runCompletion({
      baseUrl: options.settings.baseUrl,
      apiVersion: options.settings.apiVersion,
      proxyUrl: options.settings.proxyUrl,
      apiKey: options.apiKey,
      model: options.settings.model,
      messages,
      tools: options.tools,
      temperature: options.settings.temperature,
      maxTokens: options.settings.maxTokens,
      signal: options.signal,
    });

    options.onLog?.(
      `[ai-chat] Response step=${step + 1} (content=${message.content?.length ?? 0}, ` +
        `toolCalls=${message.tool_calls?.length ?? 0}).`,
    );

    if (message.content != null && message.content.trim().length > 0) {
      const separator = wroteText ? "\n\n" : "";

      wroteText = true;
      options.onEvent({ type: "delta", text: `${separator}${message.content}` });
    }

    if (message.tool_calls == null || message.tool_calls.length === 0) {
      return {};
    }

    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.tool_calls,
    });

    for (const call of message.tool_calls) {
      if (options.signal.aborted) {
        return {};
      }

      options.onEvent({ type: "tool-start", call });
      options.onEvent({ type: "status", text: `Running ${call.function.name}…` });

      const result = await options.executeTool(call);

      options.onEvent({ type: "tool-end", call, result });

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.content,
      });
    }
  }

  return {
    incomplete: `Stopped after ${options.settings.maxAgentSteps} agent steps before the model returned a final answer.`,
  };
}
