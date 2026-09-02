import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "./llm.ts";
import {
  ensureAgentDir,
  legacySessionDir,
  migrateLegacyProjectDir,
  sessionDir,
} from "./paths.ts";

export { sessionDir } from "./paths.ts";

export type SessionMeta = {
  id: string;
  created: string;
  workspace: string;
  provider?: string;
  model?: string;
};

export type SessionRef = {
  id: string;
  file: string;
  created: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type LogEntry =
  | { type: "message"; message: Message }
  | { type: "compaction"; summary: string; keepFrom: number };

export function messageEntry(message: Message): LogEntry {
  return { type: "message", message };
}

export function messagesFromLog(log: LogEntry[]): Message[] {
  const messages: Message[] = [];
  for (const entry of log) {
    if (entry.type === "message") messages.push(entry.message);
  }
  return messages;
}

const KEEP_TAIL_TOKENS = 8_000;

function isUser(message: Message | undefined): boolean {
  return message?.role === "user";
}

/** First message index to keep in context after compact. Null if the tail is under KEEP_TAIL_TOKENS. */
export function findKeepFrom(messages: Message[]): number | null {
  if (messages.length < 4) return null;
  let i = messages.length;
  let tail = 0;
  while (i > 1) {
    i -= 1;
    const row = messages[i];
    if (!row) break;
    tail += Math.ceil(JSON.stringify(row).length / 4);
    if (tail >= KEEP_TAIL_TOKENS) break;
  }
  if (tail < KEEP_TAIL_TOKENS) return null;
  while (i > 1 && !isUser(messages[i])) i -= 1;
  if (i > 1 && i < messages.length - 1) return i;
  return null;
}

export function buildContext(log: LogEntry[]): Message[] {
  const messages = messagesFromLog(log);
  let compact: { summary: string; keepFrom: number } | null = null;
  for (const entry of log) {
    if (entry.type === "compaction") compact = entry;
  }
  const system = messages[0];
  if (!compact || !system || system.role !== "system") return messages;
  const keepFrom = Math.min(Math.max(compact.keepFrom, 1), messages.length);
  if (keepFrom <= 1) return messages;
  return [
    system,
    {
      role: "user",
      content: `<compacted history>\n${compact.summary}\n</compacted history>`,
    },
    ...messages.slice(keepFrom),
  ];
}

function newId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

function parseMessage(value: unknown): Message | null {
  if (!isRecord(value) || typeof value.role !== "string") return null;

  if (value.role === "system" || value.role === "user") {
    if (typeof value.content !== "string") return null;
    return { role: value.role, content: value.content };
  }

  if (value.role === "tool") {
    if (typeof value.tool_call_id !== "string" || typeof value.content !== "string") {
      return null;
    }
    return {
      role: "tool",
      tool_call_id: value.tool_call_id,
      content: value.content,
    };
  }

  if (value.role === "assistant") {
    const content =
      value.content === null || typeof value.content === "string"
        ? value.content
        : null;
    const message: Message = { role: "assistant", content };
    if (Array.isArray(value.tool_calls)) {
      const tool_calls = [];
      for (const raw of value.tool_calls) {
        if (!isRecord(raw) || typeof raw.id !== "string") continue;
        if (!isRecord(raw.function)) continue;
        if (typeof raw.function.name !== "string") continue;
        if (typeof raw.function.arguments !== "string") continue;
        tool_calls.push({
          id: raw.id,
          type: "function" as const,
          function: {
            name: raw.function.name,
            arguments: raw.function.arguments,
          },
        });
      }
      if (tool_calls.length > 0) message.tool_calls = tool_calls;
    }
    return message;
  }

  return null;
}

export async function saveSession(
  file: string,
  meta: SessionMeta,
  log: LogEntry[],
): Promise<void> {
  await ensureAgentDir(path.dirname(file));
  const lines = [
    JSON.stringify({ type: "meta", ...meta }),
    ...log.map((entry) => JSON.stringify(entry)),
  ];
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
}

export async function createSession(
  workspace: string,
  log: LogEntry[],
  model: { provider: string; id: string },
): Promise<{ meta: SessionMeta; file: string }> {
  await migrateLegacyProjectDir(workspace);
  const meta: SessionMeta = {
    id: newId(),
    created: new Date().toISOString(),
    workspace,
    provider: model.provider,
    model: model.id,
  };
  const file = path.join(sessionDir(workspace), `${meta.id}.jsonl`);
  await saveSession(file, meta, log);
  return { meta, file };
}

export async function loadSession(
  file: string,
): Promise<{ meta: SessionMeta; log: LogEntry[] }> {
  const text = await readFile(file, "utf8");
  let meta: SessionMeta | null = null;
  const log: LogEntry[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw) || typeof raw.type !== "string") continue;

    if (raw.type === "meta") {
      if (
        typeof raw.id === "string" &&
        typeof raw.created === "string" &&
        typeof raw.workspace === "string"
      ) {
        meta = {
          id: raw.id,
          created: raw.created,
          workspace: raw.workspace,
        };
        if (typeof raw.provider === "string") meta.provider = raw.provider;
        if (typeof raw.model === "string") meta.model = raw.model;
      }
      continue;
    }

    if (raw.type === "message") {
      const message = parseMessage(raw.message);
      if (message) log.push({ type: "message", message });
      continue;
    }

    if (raw.type === "compaction") {
      if (typeof raw.summary === "string" && typeof raw.keepFrom === "number") {
        log.push({
          type: "compaction",
          summary: raw.summary,
          keepFrom: raw.keepFrom,
        });
      }
    }
  }

  if (!meta) {
    throw new Error(`session file has no meta: ${file}`);
  }
  const messages = messagesFromLog(log);
  if (messages.length === 0 || messages[0].role !== "system") {
    throw new Error(`session file has no system message: ${file}`);
  }
  return { meta, log };
}

function sessionScanDirs(workspace: string): string[] {
  const dirs = [sessionDir(workspace)];
  const legacy = legacySessionDir(workspace);
  if (path.resolve(legacy) !== path.resolve(dirs[0])) dirs.push(legacy);
  return dirs;
}

export async function listSessions(workspace: string): Promise<SessionRef[]> {
  await migrateLegacyProjectDir(workspace);

  const refs: SessionRef[] = [];
  const seen = new Set<string>();
  for (const dir of sessionScanDirs(workspace)) {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        const first = (await readFile(file, "utf8")).split("\n")[0] ?? "";
        const raw: unknown = JSON.parse(first);
        const id =
          isRecord(raw) && raw.type === "meta" && typeof raw.id === "string"
            ? raw.id
            : name.replace(/\.jsonl$/, "");
        if (seen.has(id)) continue;
        seen.add(id);
        const created =
          isRecord(raw) && raw.type === "meta" && typeof raw.created === "string"
            ? raw.created
            : info.mtime.toISOString();
        refs.push({ id, file, created });
      } catch {
        continue;
      }
    }
  }

  refs.sort((a, b) => (a.created < b.created ? 1 : -1));
  return refs;
}

export function findSession(
  refs: SessionRef[],
  currentFile: string,
  prefix?: string,
): SessionRef | null {
  const others = refs.filter((ref) => ref.file !== currentFile);
  if (!prefix) return others[0] ?? null;
  return others.find((ref) => ref.id.startsWith(prefix)) ?? null;
}

export function matchSessions(refs: SessionRef[], prefix: string): SessionRef[] {
  return refs.filter((ref) => ref.id.startsWith(prefix));
}

export async function deleteSession(file: string): Promise<void> {
  await unlink(file);
}

export async function deleteAllSessions(workspace: string): Promise<number> {
  const refs = await listSessions(workspace);
  let deleted = 0;
  for (const ref of refs) {
    try {
      await unlink(ref.file);
      deleted += 1;
    } catch {
      continue;
    }
  }
  return deleted;
}
