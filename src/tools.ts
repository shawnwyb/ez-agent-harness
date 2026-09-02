import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyFileTag,
  formatRead,
  parseLine,
  parseTag,
  previewRead,
  splitFile,
  splitReplacement,
} from "./hashline.ts";
import type { ToolDef } from "./llm.ts";
import { globSearch, grepSearch } from "./search.ts";

export const WORKSPACE = path.resolve(process.env.WORKSPACE ?? process.cwd());
const MAX_CHARS = 24_000;
const BASH_TIMEOUT_MS = 30_000;

export const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: `Read a UTF-8 file. Path is relative to ${WORKSPACE}. Starts with [path#TAG], then LINE:text. Pass TAG and line numbers to edit.`,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: `Run a shell command in ${WORKSPACE}. Use for git and tests. Prefer grep/glob to search.`,
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: `Create or overwrite a UTF-8 file relative to ${WORKSPACE}. Prefer edit for existing files. Writes to disk immediately.`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: `Replace an inclusive line range in an existing file relative to ${WORKSPACE}. Prefer tag + start/end from the last read_file ([path#TAG] and LINE:text). new_string is the replacement lines with no LINE: prefixes. old_string still works if it matches exactly once.`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          tag: { type: "string" },
          start: { type: "integer" },
          end: { type: "integer" },
          new_string: { type: "string" },
          old_string: { type: "string" },
        },
        required: ["path", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: `Search file contents in ${WORKSPACE} with a JavaScript regex. Returns path:line:text. Prefer this over bash grep.`,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: `Find files in ${WORKSPACE} by glob (e.g. **/*.ts, src/**/*.json). Prefer this over bash find.`,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
        },
        required: ["pattern"],
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

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n... truncated ${text.length - MAX_CHARS} chars`;
}

function textField(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

export function resolveInWorkspace(rel: string): string {
  const resolved = path.resolve(WORKSPACE, rel);
  const relative = path.relative(WORKSPACE, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return `error: path escapes workspace: ${rel}`;
  }
  return resolved;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n += 1;
    from = at + needle.length;
  }
}

async function loadExisting(
  rel: string,
): Promise<{ ok: true; text: string; resolved: string } | { ok: false; error: string }> {
  const resolved = resolveInWorkspace(rel);
  if (resolved.startsWith("error:")) return { ok: false, error: resolved };
  try {
    const info = await stat(resolved);
    if (info.isDirectory()) return { ok: false, error: `error: ${rel} is a directory` };
    return { ok: true, text: await readFile(resolved, "utf8"), resolved };
  } catch (err) {
    return { ok: false, error: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function editReplace(
  rel: string,
  old_string: string,
  new_string: string,
): Promise<string> {
  if (old_string.length === 0) return "error: old_string must not be empty";
  const loaded = await loadExisting(rel);
  if (!loaded.ok) return loaded.error;
  const hits = countOccurrences(loaded.text, old_string);
  if (hits === 0) return `error: old_string not found in ${rel}`;
  if (hits > 1) {
    return `error: old_string found ${hits} times in ${rel}; make it unique`;
  }
  try {
    await writeFile(loaded.resolved, loaded.text.replace(old_string, new_string), "utf8");
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return `replaced 1 block in ${rel}`;
}

async function editFileTag(
  rel: string,
  tagRaw: string,
  startRaw: unknown,
  endRaw: unknown,
  new_string: string,
): Promise<string> {
  const tag = parseTag(tagRaw);
  if (!tag) {
    return `error: tag must be the 4-hex TAG from read_file (e.g. A1B2 or [path#A1B2])`;
  }
  const start = parseLine(startRaw, "start");
  if (typeof start === "string") return start;
  const end = endRaw === undefined || endRaw === null || endRaw === ""
    ? start
    : parseLine(endRaw, "end");
  if (typeof end === "string") return end;
  const loaded = await loadExisting(rel);
  if (!loaded.ok) return loaded.error;
  const applied = applyFileTag(rel, loaded.text, { tag, start, end, new_string });
  if (typeof applied === "string") return applied;
  try {
    await writeFile(loaded.resolved, applied.next, "utf8");
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const removed = end - start + 1;
  const added = splitReplacement(new_string).length;
  const preview = previewRead(rel, applied.next, start, added);
  return `replaced lines ${start}-${end} in ${rel} (${removed} → ${added})\n${preview}`;
}

async function write_file(rel: string, content: string): Promise<string> {
  const resolved = resolveInWorkspace(rel);
  if (resolved.startsWith("error:")) return resolved;
  try {
    const info = await stat(resolved).catch(() => null);
    if (info?.isDirectory()) {
      return `error: ${rel} is a directory`;
    }
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");
    return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}`;
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function read_file(rel: string): Promise<string> {
  const resolved = resolveInWorkspace(rel);
  if (resolved.startsWith("error:")) return resolved;
  try {
    const info = await stat(resolved);
    if (info.isDirectory()) {
      return `error: ${rel} is a directory; use bash to list it`;
    }
    const raw = await readFile(resolved, "utf8");
    const numbered = formatRead(rel, raw);
    if (numbered.length <= MAX_CHARS) return numbered;
    const cut = numbered.lastIndexOf("\n", MAX_CHARS);
    const keep = cut > 0 ? numbered.slice(0, cut) : numbered.slice(0, MAX_CHARS);
    const shown = Math.max(0, keep.split("\n").length - 1);
    const total = splitFile(raw).lines.length;
    return `${keep}\n... truncated ${total - shown} of ${total} lines`;
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  }
}

async function bash(command: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return "error: aborted";

  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        PAGER: "cat",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(truncate(text));
    };

    const onAbort = () => {
      if (child.pid) killProcessTree(child.pid);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid);
    }, BASH_TIMEOUT_MS);

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += textField(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += textField(chunk);
    });

    child.on("error", (err) => {
      finish(`error: ${err.message}`);
    });

    child.on("close", (code) => {
      const out = [stdout, stderr].filter(Boolean).join("\n");
      if (signal?.aborted) {
        finish("error: aborted");
        return;
      }
      if (timedOut) {
        finish(
          truncate(
            [`error: timed out after ${BASH_TIMEOUT_MS}ms`, out]
              .filter(Boolean)
              .join("\n"),
          ),
        );
        return;
      }
      if (code !== 0 && code !== null) {
        finish(
          truncate([`error: exit ${code}`, out].filter(Boolean).join("\n")),
        );
        return;
      }
      finish(out || "(no output)");
    });
  });
}

export async function runTool(
  name: string,
  argsJson: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return "error: aborted";
  const args = parseArgs(argsJson);
  if (typeof args === "string") return args;

  if (name === "read_file") {
    if (typeof args.path !== "string" || args.path.length === 0) {
      return "error: path must be a non-empty string";
    }
    return read_file(args.path);
  }

  if (name === "bash") {
    if (typeof args.command !== "string" || args.command.length === 0) {
      return "error: command must be a non-empty string";
    }
    return bash(args.command, signal);
  }

  if (name === "write_file") {
    if (typeof args.path !== "string" || args.path.length === 0) {
      return "error: path must be a non-empty string";
    }
    if (typeof args.content !== "string") {
      return "error: content must be a string";
    }
    return write_file(args.path, args.content);
  }

  if (name === "edit") {
    if (typeof args.path !== "string" || args.path.length === 0) {
      return "error: path must be a non-empty string";
    }
    if (typeof args.new_string !== "string") {
      return "error: new_string must be a string";
    }
    if (typeof args.tag === "string" && args.tag.length > 0) {
      return editFileTag(args.path, args.tag, args.start, args.end, args.new_string);
    }
    if (typeof args.old_string === "string") {
      return editReplace(args.path, args.old_string, args.new_string);
    }
    return "error: edit needs tag + start from read_file, or old_string";
  }

  if (name === "grep") {
    if (typeof args.pattern !== "string" || args.pattern.length === 0) {
      return "error: pattern must be a non-empty string";
    }
    const grepPath = typeof args.path === "string" ? args.path : undefined;
    const grepGlob = typeof args.glob === "string" ? args.glob : undefined;
    return grepSearch(WORKSPACE, args.pattern, { path: grepPath, glob: grepGlob, signal });
  }

  if (name === "glob") {
    if (typeof args.pattern !== "string" || args.pattern.length === 0) {
      return "error: pattern must be a non-empty string";
    }
    const globRoot = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
    return globSearch(WORKSPACE, args.pattern, globRoot, signal);
  }

  return `error: unknown tool ${name}`;
}
