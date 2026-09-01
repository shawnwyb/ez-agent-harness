import { readFile } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { chat, isAbortError, type Message } from "./llm.ts";
import { runTool, TOOLS, WORKSPACE } from "./tools.ts";

const AGENTS_MD_MAX = 8_000;

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

async function loadAgentsMd(workspace: string): Promise<string | null> {
  try {
    const raw = (await readFile(path.join(workspace, "AGENTS.md"), "utf8")).trim();
    if (raw.length === 0) return null;
    if (raw.length <= AGENTS_MD_MAX) return raw;
    return `${raw.slice(0, AGENTS_MD_MAX)}\n... truncated ${raw.length - AGENTS_MD_MAX} chars`;
  } catch {
    return null;
  }
}

function printTrace(name: string, argsJson: string, result: string): void {
  const body = clipResult(result)
    .split("\n")
    .map((line, i) => (i === 0 ? `  -> ${line}` : `     ${line}`))
    .join("\n");
  stdout.write(`\n  ${name}  ${formatArgs(argsJson)}\n${body}\n`);
}

const agentsMd = await loadAgentsMd(WORKSPACE);

const system = [
  `You are ez-agent, a coding agent. Workspace: ${WORKSPACE}`,
  "Tools: read_file, bash, write_file, edit.",
  "Read a file before you change it. Use edit for existing files, write_file only to create. After you change code, verify with bash (this repo: npx tsc --noEmit). Be concise. Match existing style.",
  agentsMd ? `\n# AGENTS.md\n${agentsMd}` : "",
]
  .filter((line) => line.length > 0)
  .join("\n");

const messages: Message[] = [{ role: "system", content: system }];

const rl = createInterface({ input: stdin, output: stdout });

let turn: AbortController | null = null;

rl.on("SIGINT", () => {
  if (turn && !turn.signal.aborted) {
    turn.abort();
    return;
  }
  stdout.write("\n");
  rl.close();
  process.exit(0);
});

console.log(
  "ez-agent. Type a prompt, /clear to reset, /exit to quit. Ctrl+C cancels a run; at the prompt it quits.",
);
console.log(agentsMd ? "(loaded AGENTS.md)\n" : "(no AGENTS.md)\n");

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

  turn = new AbortController();
  const signal = turn.signal;
  let aborted = false;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) {
        aborted = true;
        break;
      }

      const assistant = await chat({
        messages,
        tools: TOOLS,
        onDelta: (delta) => stdout.write(delta),
        signal,
      });
      messages.push(assistant);

      const calls = assistant.tool_calls;
      if (!calls?.length) break;

      for (const call of calls) {
        const result = await runTool(
          call.function.name,
          call.function.arguments,
          signal,
        );
        printTrace(call.function.name, call.function.arguments, result);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
        if (signal.aborted) {
          aborted = true;
          break;
        }
      }

      if (aborted) break;

      if (step === MAX_STEPS - 1) {
        stdout.write(`\n(stopped after ${MAX_STEPS} steps)\n`);
      }
    }
    stdout.write(aborted ? "\n(aborted)\n\n" : "\n\n");
  } catch (err) {
    if (signal.aborted || isAbortError(err)) {
      stdout.write("\n(aborted)\n\n");
    } else {
      messages.length = checkpoint;
      console.error(err instanceof Error ? err.message : err);
      stdout.write("\n");
    }
  } finally {
    turn = null;
  }
}

rl.close();
