import type { ToolDef } from "./llm.ts";

export const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "echo",
      description: "Return the given text unchanged. Use when asked to call echo.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argsJson: string): Record<string, unknown> | string {
  try {
    const parsed: unknown = JSON.parse(argsJson || "{}");
    if (isRecord(parsed)) return parsed;
    return `error: arguments must be a JSON object, got ${argsJson}`;
  } catch {
    return `error: invalid JSON arguments: ${argsJson}`;
  }
}

export function runTool(name: string, argsJson: string): string {
  const args = parseArgs(argsJson);
  if (typeof args === "string") return args;

  if (name === "echo") {
    return typeof args.text === "string" ? args.text : String(args.text ?? "");
  }

  return `error: unknown tool ${name}`;
}
