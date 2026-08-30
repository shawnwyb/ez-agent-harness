import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { chat, type Message } from "./llm.ts";

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

  messages.push({ role: "user", content: input });
  stdout.write("\n");

  try {
    const reply = await chat(messages, (delta) => stdout.write(delta));
    messages.push({ role: "assistant", content: reply });
    stdout.write("\n\n");
  } catch (err) {
    messages.pop();
    console.error(err instanceof Error ? err.message : err);
    stdout.write("\n");
  }
}

rl.close();
