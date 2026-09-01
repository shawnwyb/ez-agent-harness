import { readFile } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { chat, estimateTokens, isAbortError } from "./llm.ts";
import {
  contextWindow,
  formatContext,
  formatModel,
  initialModel,
  loadSavedModel,
  modelFromMeta,
  printModels,
  resolveModel,
  saveDefaultModel,
  transportFor,
  type ModelRef,
} from "./models.ts";
import {
  buildContext,
  createSession,
  deleteAllSessions,
  deleteSession,
  findKeepFrom,
  findSession,
  listSessions,
  loadSession,
  matchSessions,
  messageEntry,
  messagesFromLog,
  saveSession,
  type LogEntry,
} from "./session.ts";
import { completePath, expandAtFiles } from "./attach.ts";
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

function buildSystem(model: ModelRef): string {
  return [
    `You are ez-agent, a coding agent. Workspace: ${WORKSPACE}`,
    `Model: ${formatModel(model)}.`,
    "Tools: read_file, bash, write_file, edit.",
    "Read a file before you change it. Use edit for existing files, write_file only to create. After you change code, verify with bash (this repo: npx tsc --noEmit). Be concise. Match existing style.",
    agentsMd ? `\n# AGENTS.md\n${agentsMd}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function applySystem(): void {
  const content = buildSystem(current);
  const first = log[0];
  if (first?.type === "message" && first.message.role === "system") {
    first.message = { role: "system", content };
  } else {
    log.unshift(messageEntry({ role: "system", content }));
  }
}

let savedDefault: ModelRef | null = await loadSavedModel(WORKSPACE);
let current: ModelRef = initialModel(savedDefault);
let log: LogEntry[] = [messageEntry({ role: "system", content: buildSystem(current) })];
let session = await createSession(WORKSPACE, log, current);
let contextUsed = estimateTokens(buildContext(log), TOOLS);

function refreshContext(apiPrompt?: number): void {
  contextUsed = apiPrompt ?? estimateTokens(buildContext(log), TOOLS);
}

function promptLabel(): string {
  return `${formatModel(current)} ${formatContext(contextUsed, contextWindow(current))}`;
}

async function persist(): Promise<void> {
  await saveSession(session.file, session.meta, log);
}

function setModel(model: ModelRef): void {
  current = model;
  session.meta.provider = model.provider;
  session.meta.model = model.id;
  applySystem();
  refreshContext();
}

async function startNewSession(): Promise<void> {
  if (savedDefault) current = savedDefault;
  log = [messageEntry({ role: "system", content: buildSystem(current) })];
  session = await createSession(WORKSPACE, log, current);
  refreshContext();
  console.log(`(new session ${session.meta.id} · ${formatModel(current)})\n`);
}

const rl = createInterface({
  input: stdin,
  output: stdout,
  completer: completePath,
});

const QUEUE_MAX = 16;
const inputQueue: string[] = [];
let waitingForLine: ((line: string) => void) | null = null;

rl.on("line", (line: string) => {
  if (waitingForLine) {
    const resolve = waitingForLine;
    waitingForLine = null;
    resolve(line);
    return;
  }
  const trimmed = line.trim();
  if (!trimmed) return;
  if (inputQueue.length >= QUEUE_MAX) {
    stdout.write("(queue full)\n");
    return;
  }
  inputQueue.push(trimmed);
  stdout.write(`(queued · ${inputQueue.length})\n`);
});

function takeQueued(): string | undefined {
  while (inputQueue.length > 0) {
    const next = inputQueue.shift();
    if (next !== undefined && next.length > 0) return next;
  }
  return undefined;
}

function readInput(): Promise<string> {
  const queued = takeQueued();
  if (queued !== undefined) {
    stdout.write(`${promptLabel()}> ${queued}\n`);
    return Promise.resolve(queued);
  }
  rl.setPrompt(`${promptLabel()}> `);
  rl.prompt();
  return new Promise<string>((resolve) => {
    waitingForLine = resolve;
  }).then((line) => line.trim());
}

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

function printHelp(): void {
  console.log(`commands:
  /help
  /model [id]              this session
  /model default [id]      save startup default
  /new, /clear             new session (keeps default model)
  /sessions
  /resume [id]
  /compact [focus]         summarize old turns; file keeps them
  /delete current | <id> | all
  @path                    attach a workspace file; tab completes paths
  /exit, /quit
  Ctrl+C                   cancel a run; at the prompt, quit
`);
}

console.log("ez-agent. /help lists commands.");
console.log(agentsMd ? "(loaded AGENTS.md)" : "(no AGENTS.md)");
console.log(`(session ${session.meta.id} · ${formatModel(current)})\n`);

while (true) {
  const input = await readInput();
  if (!input) continue;
  if (input === "/exit" || input === "/quit") break;
  if (input === "/help" || input === "/?") {
    printHelp();
    continue;
  }
  if (input === "/clear" || input === "/new") {
    await startNewSession();
    continue;
  }
  if (input === "/model" || input.startsWith("/model ")) {
    const query = input === "/model" ? "" : input.slice("/model ".length).trim();
    if (!query) {
      printModels(current, savedDefault);
      continue;
    }
    if (query === "default" || query.startsWith("default ")) {
      const rest = query === "default" ? "" : query.slice("default ".length).trim();
      if (rest) {
        const resolved = resolveModel(rest);
        if (resolved.kind === "ok") {
          setModel(resolved.model);
          await persist();
        } else if (resolved.kind === "many") {
          console.log("(ambiguous; pick one)");
          for (const model of resolved.models) {
            console.log(`  ${formatModel(model)}`);
          }
          stdout.write("\n");
          continue;
        } else {
          console.log(`(no match: ${rest})\n`);
          continue;
        }
      }
      savedDefault = current;
      await saveDefaultModel(WORKSPACE, current);
      console.log(`(default ${formatModel(current)})\n`);
      continue;
    }
    const resolved = resolveModel(query);
    if (resolved.kind === "ok") {
      setModel(resolved.model);
      await persist();
      console.log(`(model ${formatModel(current)})\n`);
      continue;
    }
    if (resolved.kind === "many") {
      console.log("(ambiguous; pick one)");
      for (const model of resolved.models) {
        console.log(`  ${formatModel(model)}`);
      }
      stdout.write("\n");
      continue;
    }
    console.log(`(no match: ${query})\n`);
    continue;
  }
  if (input === "/delete" || input.startsWith("/delete ")) {
    const arg = input === "/delete" ? "" : input.slice("/delete ".length).trim();
    if (!arg) {
      console.log("(/delete current  |  /delete <id prefix>  |  /delete all)\n");
      continue;
    }
    const refs = await listSessions(WORKSPACE);
    if (arg === "all") {
      const deleted = await deleteAllSessions(WORKSPACE);
      console.log(`(deleted ${deleted} session${deleted === 1 ? "" : "s"})`);
      await startNewSession();
      continue;
    }
    if (arg === "current" || arg === ".") {
      const id = session.meta.id;
      try {
        await deleteSession(session.file);
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        stdout.write("\n");
        continue;
      }
      console.log(`(deleted ${id})`);
      await startNewSession();
      continue;
    }
    const hits = matchSessions(refs, arg);
    if (hits.length === 0) {
      console.log("(no session matches that id)\n");
      continue;
    }
    if (hits.length > 1) {
      console.log("(ambiguous; pick a longer prefix)");
      for (const ref of hits) {
        console.log(`  ${ref.id}`);
      }
      stdout.write("\n");
      continue;
    }
    const target = hits[0];
    if (!target) {
      console.log("(no session matches that id)\n");
      continue;
    }
    const wasCurrent = target.file === session.file;
    try {
      await deleteSession(target.file);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      stdout.write("\n");
      continue;
    }
    console.log(`(deleted ${target.id})`);
    if (wasCurrent) {
      await startNewSession();
    } else {
      stdout.write("\n");
    }
    continue;
  }
  if (input === "/sessions") {
    const refs = await listSessions(WORKSPACE);
    if (refs.length === 0) {
      console.log("(no sessions)\n");
      continue;
    }
    for (const ref of refs) {
      const mark = ref.file === session.file ? " (current)" : "";
      console.log(`${ref.id}${mark}`);
    }
    stdout.write("\n");
    continue;
  }
  if (input === "/resume" || input.startsWith("/resume ")) {
    const prefix = input === "/resume" ? undefined : input.slice("/resume ".length).trim();
    const refs = await listSessions(WORKSPACE);
    const found = findSession(refs, session.file, prefix || undefined);
    if (!found) {
      console.log("(no other session to resume)\n");
      continue;
    }
    const loaded = await loadSession(found.file);
    session = { meta: loaded.meta, file: found.file };
    log = loaded.log;
    const restored = modelFromMeta(loaded.meta.provider, loaded.meta.model);
    if (restored) current = restored;
    applySystem();
    refreshContext();
    await persist();
    console.log(
      `(resumed ${session.meta.id}, ${messagesFromLog(log).length} messages · ${formatModel(current)})\n`,
    );
    continue;
  }
  if (input === "/compact" || input.startsWith("/compact ")) {
    const focus = input === "/compact" ? "" : input.slice("/compact ".length).trim();
    const all = messagesFromLog(log);
    const keepFrom = findKeepFrom(all);
    if (keepFrom === null) {
      console.log("(nothing to compact)\n");
      continue;
    }
    let blob = JSON.stringify(all.slice(1, keepFrom));
    if (blob.length > 80_000) blob = `${blob.slice(0, 80_000)}\n… truncated`;
    const extra = focus ? ` Focus on: ${focus}.` : "";
    stdout.write("(compacting…)\n");
    turn = new AbortController();
    try {
      const result = await chat({
        messages: [
          {
            role: "system",
            content: `Summarize this coding-agent transcript for later turns.${extra} Keep files touched, decisions, errors, and unfinished work. Dense. No tools.`,
          },
          { role: "user", content: blob },
        ],
        tools: [],
        onDelta: (delta) => stdout.write(delta),
        signal: turn.signal,
        ...transportFor(current),
      });
      const summary = result.message.content?.trim() ?? "";
      if (!summary) {
        stdout.write("\n(compact failed: empty summary)\n\n");
      } else {
        log.push({ type: "compaction", summary, keepFrom });
        await persist();
        refreshContext();
        const gauge = formatContext(contextUsed, contextWindow(current));
        stdout.write(`\n(compacted · ${gauge})\n\n`);
      }
    } catch (err) {
      if (turn.signal.aborted || isAbortError(err)) {
        stdout.write("\n(aborted)\n\n");
      } else {
        console.error(err instanceof Error ? err.message : err);
        stdout.write("\n");
      }
    } finally {
      turn = null;
    }
    continue;
  }

  const checkpoint = log.length;
  const expanded = await expandAtFiles(input);
  for (const notice of expanded.notices) stdout.write(`${notice}\n`);
  log.push(messageEntry({ role: "user", content: expanded.content }));
  await persist();
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

      const result = await chat({
        messages: buildContext(log),
        tools: TOOLS,
        onDelta: (delta) => stdout.write(delta),
        signal,
        ...transportFor(current),
      });
      log.push(messageEntry(result.message));
      refreshContext(result.usage?.promptTokens);

      const calls = result.message.tool_calls;
      if (!calls?.length) break;

      for (const call of calls) {
        const toolResult = await runTool(
          call.function.name,
          call.function.arguments,
          signal,
        );
        printTrace(call.function.name, call.function.arguments, toolResult);
        log.push(
          messageEntry({
            role: "tool",
            tool_call_id: call.id,
            content: toolResult,
          }),
        );
        refreshContext();
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
    refreshContext();
    const gauge = formatContext(contextUsed, contextWindow(current));
    stdout.write(aborted ? `\n(aborted · ${gauge})\n\n` : `\n(${gauge})\n\n`);
    await persist();
  } catch (err) {
    if (signal.aborted || isAbortError(err)) {
      refreshContext();
      const gauge = formatContext(contextUsed, contextWindow(current));
      stdout.write(`\n(aborted · ${gauge})\n\n`);
      await persist();
    } else {
      log.length = checkpoint;
      refreshContext();
      console.error(err instanceof Error ? err.message : err);
      stdout.write("\n");
      await persist();
    }
  } finally {
    turn = null;
  }
}

rl.close();
