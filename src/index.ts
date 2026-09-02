#!/usr/bin/env node
import "./env.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chat, estimateTokens, isAbortError } from "./llm.ts";
import {
  contextWindow,
  formatContext,
  formatModel,
  formatModelsList,
  hasKey,
  initialModel,
  isProviderId,
  loadSavedModel,
  modelFromMeta,
  resolveModel,
  saveDefaultModel,
  transportFor,
  type ModelRef,
  type ProviderId,
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
import { deleteAuthKey, writeAuthKey } from "./auth.ts";
import { confirmUnlink, isYes, unlinkGlobal } from "./install.ts";
import { runTool, TOOLS, WORKSPACE } from "./tools.ts";
import { HELP, startScreen } from "./tui.ts";

if (process.argv[2] === "uninstall") {
  const yes = await confirmUnlink();
  if (!yes) {
    console.error("aborted");
    process.exit(1);
  }
  const result = await unlinkGlobal();
  console.error(result.message);
  process.exit(result.ok ? 0 : 1);
}

const AGENTS_MD_MAX = 8_000;

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
    "Tools: read_file, bash, write_file, edit, grep, glob.",
    "Read a file before you change it. read_file starts with [path#TAG] then LINE:text. edit uses that TAG plus 1-based start/end; do not retype old text. old_string is a fallback. write_file only to create. Use grep for file contents and glob for paths; do not bash find/grep. edit/write_file append (tsc: ok) or (tsc: errors) when tsconfig.json exists; fix errors before you finish. Be concise. Match existing style.",
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
let pendingUninstall = false;
let pendingLogin: ProviderId | null = null;

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
  if (pendingUninstall) {
    pendingUninstall = false;
    if (isYes(input)) {
      const result = await unlinkGlobal();
      screen.note(result.message);
      if (result.ok) {
        quitting = true;
        break;
      }
      continue;
    }
    if (input === "/exit" || input === "/quit") break;
    screen.note("(uninstall cancelled)");
    continue;
  }
  if (pendingLogin) {
    const provider = pendingLogin;
    pendingLogin = null;
    if (input === "/exit" || input === "/quit") break;
    if (input.startsWith("/")) {
      screen.note("(login cancelled)");
      continue;
    }
    writeAuthKey(provider, input.trim());
    screen.note(`(saved ${provider} key)`);
    continue;
  }
  if (input === "/exit" || input === "/quit") break;
  if (input === "/login" || input.startsWith("/login ")) {
    const rest = input === "/login" ? "" : input.slice("/login ".length).trim();
    if (!rest) {
      screen.note(
        [
          "/login xai | anthropic",
          `xai${hasKey("xai") ? "" : "  (no key)"}`,
          `anthropic${hasKey("anthropic") ? "" : "  (no key)"}`,
        ].join("\n"),
      );
      continue;
    }
    const space = rest.indexOf(" ");
    const prov = (space === -1 ? rest : rest.slice(0, space)).trim();
    const inline = space === -1 ? "" : rest.slice(space).trim();
    if (!isProviderId(prov)) {
      screen.note(`(unknown provider: ${prov})`);
      continue;
    }
    if (inline) {
      writeAuthKey(prov, inline);
      screen.note(`(saved ${prov} key)`);
      continue;
    }
    pendingLogin = prov;
    screen.note(`Paste the ${prov} API key. It is not written to the session.`);
    continue;
  }
  if (input === "/logout" || input.startsWith("/logout ")) {
    const rest = input === "/logout" ? "" : input.slice("/logout ".length).trim();
    if (!rest || !isProviderId(rest)) {
      screen.note("/logout xai | anthropic");
      continue;
    }
    screen.note(deleteAuthKey(rest) ? `(removed ${rest} key)` : `(no ${rest} key in auth.json)`);
    continue;
  }
  if (input === "/uninstall") {
    pendingUninstall = true;
    screen.note("Remove the global ezagent command? Type y to confirm, anything else to cancel.");
    continue;
  }
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
    while (true) {
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
        if (signal.aborted) {
          aborted = true;
          break;
        }
      }

      if (aborted) break;
    }
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

