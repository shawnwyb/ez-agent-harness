import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { chat, type Message } from "./llm.ts";
import { runTool, TOOLS } from "./tools.ts";

const MAX_STEPS = 8;

const messages: Message[] = [
  { role: "system", content: "You are a helpful coding agent. Be concise." },
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
        const result = runTool(call.function.name, call.function.arguments);
        stdout.write(
          `\n[${call.function.name}] ${call.function.arguments} -> ${result}\n`,
        );
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
