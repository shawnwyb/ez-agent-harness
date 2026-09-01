export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type AssistantMessage = Extract<Message, { role: "assistant" }>;

export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string }>;
      required?: string[];
    };
  };
};

type ToolCallAcc = {
  id?: string;
  name?: string;
  arguments: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyToolCallDelta(acc: ToolCallAcc[], delta: unknown): void {
  if (!isRecord(delta)) return;
  const index = delta.index;
  if (typeof index !== "number") return;

  const slot = acc[index] ?? { arguments: "" };
  if (typeof delta.id === "string") slot.id = delta.id;

  if (isRecord(delta.function)) {
    if (typeof delta.function.name === "string") {
      slot.name = (slot.name ?? "") + delta.function.name;
    }
    if (typeof delta.function.arguments === "string") {
      slot.arguments += delta.function.arguments;
    }
  }
  acc[index] = slot;
}

function finishToolCalls(acc: ToolCallAcc[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const slot of acc) {
    if (!slot?.id || !slot.name) continue;
    calls.push({
      id: slot.id,
      type: "function",
      function: { name: slot.name, arguments: slot.arguments },
    });
  }
  return calls;
}

function assembleAssistant(
  content: string,
  toolCallAcc: ToolCallAcc[],
): AssistantMessage {
  const tool_calls = finishToolCalls(toolCallAcc);
  const message: AssistantMessage = {
    role: "assistant",
    content: content.length > 0 ? content : tool_calls.length > 0 ? null : "",
  };
  if (tool_calls.length > 0) message.tool_calls = tool_calls;
  return message;
}

function readChoiceDelta(chunk: unknown): {
  content?: string;
  tool_calls?: unknown[];
} {
  if (!isRecord(chunk)) return {};
  const choices = chunk.choices;
  if (!Array.isArray(choices) || !isRecord(choices[0])) return {};
  const delta = choices[0].delta;
  if (!isRecord(delta)) return {};
  return {
    content: typeof delta.content === "string" ? delta.content : undefined,
    tool_calls: Array.isArray(delta.tool_calls) ? delta.tool_calls : undefined,
  };
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export type ChatUsage = {
  promptTokens: number;
  completionTokens: number;
};

export type ChatResult = {
  message: AssistantMessage;
  usage: ChatUsage | null;
};

function readUsage(chunk: unknown): ChatUsage | null {
  if (!isRecord(chunk) || !isRecord(chunk.usage)) return null;
  const prompt = chunk.usage.prompt_tokens;
  if (typeof prompt !== "number") return null;
  const completion = chunk.usage.completion_tokens;
  return {
    promptTokens: prompt,
    completionTokens: typeof completion === "number" ? completion : 0,
  };
}

export function estimateTokens(messages: Message[], tools: ToolDef[]): number {
  return Math.ceil(JSON.stringify({ messages, tools }).length / 4);
}

export async function chat({
  messages,
  tools,
  onDelta,
  signal,
  apiKey,
  baseUrl,
  model,
}: {
  messages: Message[];
  tools: ToolDef[];
  onDelta: (text: string) => void;
  signal?: AbortSignal;
  apiKey: string;
  baseUrl: string;
  model: string;
}): Promise<ChatResult> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length > 0 ? { tools } : {}),
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM ${res.status}: ${body}`);
  }

  return readSse(res, onDelta, signal);
}

async function readSse(
  res: Response,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<ChatResult> {
  if (!res.body) {
    throw new Error("LLM response had no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCallAcc: ToolCallAcc[] = [];
  let usage: ChatUsage | null = null;

  const cancelRead = () => {
    void reader.cancel();
  };
  signal?.addEventListener("abort", cancelRead);

  const consumeLine = (line: string) => {
    const data = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!data || data === "[DONE]") return;

    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }

    const nextUsage = readUsage(chunk);
    if (nextUsage) usage = nextUsage;

    const delta = readChoiceDelta(chunk);
    if (delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    for (const part of delta.tool_calls ?? []) {
      applyToolCallDelta(toolCallAcc, part);
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    }

    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);

    return { message: assembleAssistant(content, toolCallAcc), usage };
  } finally {
    signal?.removeEventListener("abort", cancelRead);
  }
}
