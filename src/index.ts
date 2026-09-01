import { readFile } from "node:fs/promises";
import path from "node:path";
import { chat, estimateTokens, isAbortError } from "./llm.ts";
import {
  contextWindow,
  formatContext,
  formatModel,
  formatModelsList,
  initialModel,
  loadSavedModel,
  modelFromMeta,
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
import { expandAtFiles } from "./attach.ts";
import { runTool, TOOLS, WORKSPACE } from "./tools.ts";
import { HELP, startScreen } from "./tui.ts";

const AGENTS_MD_MAX = 8_000;

const MAX_STEPS = 8;

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

function printIntro(): void {
  screen.note("ez-agent. /help lists commands.");
  screen.note(agentsMd ? "(loaded AGENTS.md)" : "(no AGENTS.md)");
  screen.note(`(session ${session.meta.id} · ${formatModel(current)})`);
}

async function startNewSession(): Promise<void> {
  if (savedDefault) current = savedDefault;
  log = [messageEntry({ role: "system", content: buildSystem(current) })];
  session = await createSession(WORKSPACE, log, current);
  refreshContext();
  screen.setFooter(promptLabel());
  screen.note(`(new session ${session.meta.id} · ${formatModel(current)})`);
}

function clearChat(): void {
  screen.clearView();
  printIntro();
}

let turn: AbortController | null = null;
let quitting = false;

const screen = startScreen({
  onAbort: () => {
    if (turn && !turn.signal.aborted) {
      turn.abort();
      return true;
    }
    return false;
  },
  onQuit: () => {
    quitting = true;
    turn?.abort();
    screen.stop();
    process.exit(0);
  },
});

screen.setFooter(promptLabel());
printIntro();

while (!quitting) {
  screen.setFooter(promptLabel());
  const input = await screen.waitLine();
  if (!input) continue;
  if (input === "/exit" || input === "/quit") break;
  if (input === "/help" || input === "/?") {
    screen.note(HELP);
    continue;
  }
  if (input === "/new") {
    await startNewSession();
    continue;
  }
  if (input === "/clear") {
    clearChat();
    continue;
  }
  if (input === "/model" || input.startsWith("/model ")) {
    const query = input === "/model" ? "" : input.slice("/model ".length).trim();
    if (!query) {
      screen.note(formatModelsList(current, savedDefault));
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
          screen.note(
            ["(ambiguous; pick one)", ...resolved.models.map((model) => `  ${formatModel(model)}`)].join(
              "\n",
            ),
          );
          continue;
        } else {
          screen.note(`(no match: ${rest})`);
          continue;
        }
      }
      savedDefault = current;
      await saveDefaultModel(WORKSPACE, current);
      screen.note(`(default ${formatModel(current)})`);
      continue;
    }
    const resolved = resolveModel(query);
    if (resolved.kind === "ok") {
      setModel(resolved.model);
      await persist();
      screen.note(`(model ${formatModel(current)})`);
      continue;
    }
    if (resolved.kind === "many") {
      screen.note(
        ["(ambiguous; pick one)", ...resolved.models.map((model) => `  ${formatModel(model)}`)].join(
          "\n",
        ),
      );
      continue;
    }
    screen.note(`(no match: ${query})`);
    continue;
  }
  if (input === "/delete" || input.startsWith("/delete ")) {
    const arg = input === "/delete" ? "" : input.slice("/delete ".length).trim();
    if (!arg) {
      screen.note("(/delete current  |  /delete <id prefix>  |  /delete all)");
      continue;
    }
    const refs = await listSessions(WORKSPACE);
    if (arg === "all") {
      const deleted = await deleteAllSessions(WORKSPACE);
      screen.note(`(deleted ${deleted} session${deleted === 1 ? "" : "s"})`);
      await startNewSession();
      continue;
    }
    if (arg === "current" || arg === ".") {
      const id = session.meta.id;
      try {
        await deleteSession(session.file);
      } catch (err) {
        screen.note(err instanceof Error ? err.message : String(err));
        continue;
      }
      screen.note(`(deleted ${id})`);
      await startNewSession();
      continue;
    }
    const hits = matchSessions(refs, arg);
    if (hits.length === 0) {
      screen.note("(no session matches that id)");
      continue;
    }
    if (hits.length > 1) {
      screen.note(
        ["(ambiguous; pick a longer prefix)", ...hits.map((ref) => `  ${ref.id}`)].join("\n"),
      );
      continue;
    }
    const target = hits[0];
    if (!target) {
      screen.note("(no session matches that id)");
      continue;
    }
    const wasCurrent = target.file === session.file;
    try {
      await deleteSession(target.file);
    } catch (err) {
      screen.note(err instanceof Error ? err.message : String(err));
      continue;
    }
    screen.note(`(deleted ${target.id})`);
    if (wasCurrent) await startNewSession();
    continue;
  }
  if (input === "/sessions") {
    const refs = await listSessions(WORKSPACE);
    if (refs.length === 0) {
      screen.note("(no sessions)");
      continue;
    }
    screen.note(
      refs
        .map((ref) => `${ref.id}${ref.file === session.file ? " (current)" : ""}`)
        .join("\n"),
    );
    continue;
  }
  if (input === "/resume" || input.startsWith("/resume ")) {
    const prefix = input === "/resume" ? undefined : input.slice("/resume ".length).trim();
    const refs = await listSessions(WORKSPACE);
    const found = findSession(refs, session.file, prefix || undefined);
    if (!found) {
      screen.note("(no other session to resume)");
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
    screen.note(
      `(resumed ${session.meta.id}, ${messagesFromLog(log).length} messages · ${formatModel(current)})`,
    );
    continue;
  }
  if (input === "/compact" || input.startsWith("/compact ")) {
    const focus = input === "/compact" ? "" : input.slice("/compact ".length).trim();
    const all = messagesFromLog(log);
    const keepFrom = findKeepFrom(all);
    if (keepFrom === null) {
      screen.note("(nothing to compact)");
      continue;
    }
    let blob = JSON.stringify(all.slice(1, keepFrom));
    if (blob.length > 80_000) blob = `${blob.slice(0, 80_000)}\n… truncated`;
    const extra = focus ? ` Focus on: ${focus}.` : "";
    screen.note("(compacting…)");
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
        onDelta: (delta) => screen.assistantDelta(delta),
        signal: turn.signal,
        ...transportFor(current),
      });
      const summary = result.message.content?.trim() ?? "";
      if (!summary) {
        screen.note("(compact failed: empty summary)");
      } else {
        log.push({ type: "compaction", summary, keepFrom });
        await persist();
        refreshContext();
        screen.setFooter(promptLabel());
        screen.note("(compacted)");
      }
    } catch (err) {
      if (turn.signal.aborted || isAbortError(err)) {
        screen.note("(aborted)");
      } else {
        screen.note(err instanceof Error ? err.message : String(err));
      }
    } finally {
      turn = null;
    }
    continue;
  }

  const checkpoint = log.length;
  const expanded = await expandAtFiles(input);
  for (const notice of expanded.notices) screen.note(notice);
  screen.user(input);
  log.push(messageEntry({ role: "user", content: expanded.content }));
  await persist();

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
        onDelta: (delta) => screen.assistantDelta(delta),
        signal,
        ...transportFor(current),
      });
      log.push(messageEntry(result.message));
      refreshContext(result.usage?.promptTokens);
      screen.setFooter(promptLabel());

      const calls = result.message.tool_calls;
      if (!calls?.length) break;

      for (const call of calls) {
        const toolResult = await runTool(
          call.function.name,
          call.function.arguments,
          signal,
        );
        screen.tool(call.function.name, call.function.arguments, toolResult);
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
        screen.note(`(stopped after ${MAX_STEPS} steps)`);
      }
    }
    refreshContext();
    screen.setFooter(promptLabel());
    if (aborted) screen.note("(aborted)");
    await persist();
  } catch (err) {
    if (signal.aborted || isAbortError(err)) {
      refreshContext();
      screen.setFooter(promptLabel());
      screen.note("(aborted)");
      await persist();
    } else {
      log.length = checkpoint;
      refreshContext();
      screen.note(err instanceof Error ? err.message : String(err));
      screen.setFooter(promptLabel());
      await persist();
    }
  } finally {
    turn = null;
  }
}

screen.stop();

