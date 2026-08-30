export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatChunk = {
  choices: { delta?: { content?: string } }[];
};

export async function chat(
  messages: Message[],
  onDelta: (text: string) => void,
): Promise<string> {
  const apiKey = process.env.XAI_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Set XAI_API_KEY or OPENAI_API_KEY in .env");
  }

  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.x.ai/v1").replace(
    /\/$/,
    "",
  );
  const model = process.env.MODEL ?? "grok-4.6";

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, stream: true }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM ${res.status}: ${body}`);
  }

  return readSse(res, onDelta);
}

async function readSse(
  res: Response,
  onDelta: (text: string) => void,
): Promise<string> {
  if (!res.body) {
    throw new Error("LLM response had no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;

      const chunk = JSON.parse(data) as ChatChunk;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        full += delta;
        onDelta(delta);
      }
    }
  }

  return full;
}
