import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { chat, type Message } from "./llm.ts";
import { runTool, TOOLS, WORKSPACE } from "./tools.ts";

const MAX_STEPS = 8;
const TRACE_ARG_CHARS = 80;
const TRACE_RESULT_LINES = 8;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

function clipResult(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= TRACE_RESULT_LINES) return text;
  const hidden = lines.length - TRACE_RESULT_LINES;
  return `${lines.slice(0, TRACE_RESULT_LINES).join("\n")}\n… ${hidden} more lines`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatArgs(argsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argsJson || "{}");
    if (!isRecord(parsed)) return clip(argsJson, 120);
    return Object.entries(parsed)
      .map(([key, value]) => {
        const shown = typeof value === "string" ? value : JSON.stringify(value);
        return `${key}=${clip(shown, TRACE_ARG_CHARS)}`;
      })
      .join(" ");
  } catch {
    return clip(argsJson, 120);
  }
}

function printTrace(name: string, argsJson: string, result: string): void {
  const body = clipResult(result)
    .split("\n")
    .map((line, i) => (i === 0 ? `  -> ${line}` : `     ${line}`))
    .join("\n");
  stdout.write(`\n  ${name}  ${formatArgs(argsJson)}\n${body}\n`);
}

const messages: Message[] = [
  {
    role: "system",
    content: `You are ez-agent, a coding agent. Workspace: ${WORKSPACE}
    Tools: read_file, bash, write_file.
    Read a file before you change it. After you change code, verify with bash (this repo: npx tsc --noEmit). Be concise. Match existing style.`,
  },
];

const rl = createInterface({ input: stdin, output: stdout });

console.log("ez-agent. Type a prompt, /clear to reset, /exit to quit\n");

while (true) {
  const input = (await rl.question("> ")).trim();
  if (!input) continue;
  if (input === "/exit" || input === "/quit") break;
  if (input === "/clear") {
    messages.length = 1;
    console.log("(context cleared)\n");
    continue;
  }

  const checkpoint = messages.length;
  messages.push({ role: "user", content: input });
  stdout.write("\n");

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const assistant = await chat({
        messages,
        tools: TOOLS,
        onDelta: (delta) => stdout.write(delta),
      });
      messages.push(assistant);

      const calls = assistant.tool_calls;
      if (!calls?.length) break;

      for (const call of calls) {
        const result = await runTool(call.function.name, call.function.arguments);
        printTrace(call.function.name, call.function.arguments, result);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }

      if (step === MAX_STEPS - 1) {
        stdout.write(`\n(stopped after ${MAX_STEPS} steps)\n`);
      }
    }
    stdout.write("\n\n");
  } catch (err) {
    messages.length = checkpoint;
    console.error(err instanceof Error ? err.message : err);
    stdout.write("\n");
  }
}

rl.close();
