import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolDef } from "./llm.ts";

const execFileAsync = promisify(execFile);

export const WORKSPACE = path.resolve(process.env.WORKSPACE ?? process.cwd());
const MAX_CHARS = 24_000;
const BASH_TIMEOUT_MS = 30_000;

export const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: `Read a UTF-8 file. Path is relative to ${WORKSPACE}.`,
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
      description: `Run a shell command in ${WORKSPACE}. Use for listing files, git, and tests.`,
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
      description: `Create or overwrite a UTF-8 file relative to ${WORKSPACE}. Read it first if it exists. Writes to disk immediately.`,
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

function resolveInWorkspace(rel: string): string {
  const resolved = path.resolve(WORKSPACE, rel);
  const relative = path.relative(WORKSPACE, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return `error: path escapes workspace: ${rel}`;
  }
  return resolved;
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

async function read_file(rel: string): Promise<string> {
  const resolved = resolveInWorkspace(rel);
  if (resolved.startsWith("error:")) return resolved;
  try {
    const info = await stat(resolved);
    if (info.isDirectory()) {
      return `error: ${rel} is a directory; use bash to list it`;
    }
    return truncate(await readFile(resolved, "utf8"));
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function formatExecError(err: unknown): string {
  if (!isRecord(err)) return `error: ${String(err)}`;
  const header =
    err.killed === true
      ? `error: timed out after ${BASH_TIMEOUT_MS}ms`
      : `error: exit ${String(err.code ?? "unknown")}`;
  return truncate(
    [header, textField(err.stdout), textField(err.stderr)].filter(Boolean).join("\n"),
  );
}

async function bash(command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", command], {
      cwd: WORKSPACE,
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: MAX_CHARS * 2,
      env: {
        ...process.env,
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        PAGER: "cat",
      },
    });
    const out = [textField(stdout), textField(stderr)].filter(Boolean).join("\n");
    return truncate(out || "(no output)");
  } catch (err) {
    return formatExecError(err);
  }
}

export async function runTool(name: string, argsJson: string): Promise<string> {
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
    return bash(args.command);
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

  return `error: unknown tool ${name}`;
}
