import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "./llm.ts";

export type SessionMeta = {
  id: string;
  created: string;
  workspace: string;
};

export type SessionRef = {
  id: string;
  file: string;
  created: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sessionDir(workspace: string): string {
  return path.join(workspace, ".ez-agent", "sessions");
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
  messages: Message[],
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ type: "meta", ...meta }),
    ...messages.map((message) => JSON.stringify({ type: "message", message })),
  ];
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
}

export async function createSession(
  workspace: string,
  messages: Message[],
): Promise<{ meta: SessionMeta; file: string }> {
  const meta: SessionMeta = {
    id: newId(),
    created: new Date().toISOString(),
    workspace,
  };
  const file = path.join(sessionDir(workspace), `${meta.id}.jsonl`);
  await saveSession(file, meta, messages);
  return { meta, file };
}

export async function loadSession(
  file: string,
): Promise<{ meta: SessionMeta; messages: Message[] }> {
  const text = await readFile(file, "utf8");
  let meta: SessionMeta | null = null;
  const messages: Message[] = [];

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
        meta = { id: raw.id, created: raw.created, workspace: raw.workspace };
      }
      continue;
    }

    if (raw.type === "message") {
      const message = parseMessage(raw.message);
      if (message) messages.push(message);
    }
  }

  if (!meta) {
    throw new Error(`session file has no meta: ${file}`);
  }
  if (messages.length === 0 || messages[0].role !== "system") {
    throw new Error(`session file has no system message: ${file}`);
  }
  return { meta, messages };
}

export async function listSessions(workspace: string): Promise<SessionRef[]> {
  const dir = sessionDir(workspace);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const refs: SessionRef[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      const first = (await readFile(file, "utf8")).split("\n")[0] ?? "";
      const raw: unknown = JSON.parse(first);
      if (
        isRecord(raw) &&
        raw.type === "meta" &&
        typeof raw.id === "string" &&
        typeof raw.created === "string"
      ) {
        refs.push({
          id: raw.id,
          file,
          created: raw.created,
        });
        continue;
      }
      refs.push({
        id: name.replace(/\.jsonl$/, ""),
        file,
        created: info.mtime.toISOString(),
      });
    } catch {
      continue;
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
