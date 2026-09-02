import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const SKIP_DIR = new Set(["node_modules", ".git", ".ez-agent", "dist"]);
const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 1_000_000;
const MAX_CHARS = 24_000;

function resolveIn(workspace: string, rel: string): string {
  const resolved = path.resolve(workspace, rel);
  const relative = path.relative(workspace, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return `error: path escapes workspace: ${rel}`;
  }
  return resolved;
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]+)\}/.exec(pattern);
  if (!m || m.index === undefined || !m[1]) return [pattern];
  const out: string[] = [];
  for (const alt of m[1].split(",")) {
    const next = pattern.slice(0, m.index) + alt + pattern.slice(m.index + m[0].length);
    out.push(...expandBraces(next));
  }
  return out;
}

/** Glob like ** / *.ts or src/** — match workspace-relative posix paths. */
export function globToRegExp(pattern: string): RegExp {
  const norm = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  let re = "^";
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === "*" && norm[i + 1] === "*") {
      re += norm[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += norm[i + 2] === "/" ? 2 : 1;
    } else if (ch === "*") {
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch && ".+^${}()|[]\\".includes(ch)) {
      re += `\\${ch}`;
    } else if (ch) {
      re += ch;
    }
  }
  return new RegExp(`${re}$`);
}

function matchesGlob(relPosix: string, pattern: string): boolean {
  const name = relPosix.split("/").pop() ?? relPosix;
  for (const alt of expandBraces(pattern)) {
    const re = globToRegExp(alt);
    if (re.test(relPosix) || re.test(name)) return true;
  }
  return false;
}

async function walkFiles(
  workspace: string,
  relDir: string,
  hits: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return "error: aborted";
  const abs = resolveIn(workspace, relDir || ".");
  if (abs.startsWith("error:")) return abs;
  let ents;
  try {
    ents = await readdir(abs, { withFileTypes: true });
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  for (const ent of ents) {
    if (signal?.aborted) return "error: aborted";
    if (ent.name.startsWith(".") || SKIP_DIR.has(ent.name)) continue;
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      const err = await walkFiles(workspace, rel, hits, signal);
      if (err) return err;
    } else if (ent.isFile()) {
      hits.push(toPosix(rel));
    }
  }
  return null;
}

function clip(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n... truncated ${text.length - MAX_CHARS} chars`;
}

export async function globSearch(
  workspace: string,
  pattern: string,
  root = ".",
  signal?: AbortSignal,
): Promise<string> {
  if (pattern.length === 0) return "error: pattern must be a non-empty string";
  const files: string[] = [];
  const walkRoot = root === "" || root === "." ? "" : toPosix(root).replace(/\/$/, "");
  const err = await walkFiles(workspace, walkRoot, files, signal);
  if (err) return err;
  const hits = files.filter((rel) => matchesGlob(rel, pattern));
  if (hits.length === 0) return "(no matches)";
  const shown = hits.slice(0, MAX_MATCHES);
  const extra = hits.length > MAX_MATCHES ? `\n... truncated ${hits.length - MAX_MATCHES} paths` : "";
  return clip(shown.join("\n") + extra);
}

export async function grepSearch(
  workspace: string,
  pattern: string,
  opts: { path?: string; glob?: string; signal?: AbortSignal } = {},
): Promise<string> {
  if (pattern.length === 0) return "error: pattern must be a non-empty string";
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return `error: invalid regex: ${err instanceof Error ? err.message : String(err)}`;
  }

  const root = opts.path && opts.path.length > 0 ? toPosix(opts.path).replace(/\/$/, "") : "";
  const absRoot = resolveIn(workspace, root || ".");
  if (absRoot.startsWith("error:")) return absRoot;

  let files: string[] = [];
  try {
    const info = await stat(absRoot);
    if (info.isFile()) {
      files = [root || toPosix(path.relative(workspace, absRoot))];
    } else if (info.isDirectory()) {
      const err = await walkFiles(workspace, root, files, opts.signal);
      if (err) return err;
    } else {
      return `error: not a file or directory: ${opts.path ?? "."}`;
    }
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (opts.glob && opts.glob.length > 0) {
    files = files.filter((rel) => matchesGlob(rel, opts.glob ?? ""));
  }

  const lines: string[] = [];
  let truncated = false;
  for (const rel of files) {
    if (opts.signal?.aborted) return "error: aborted";
    if (lines.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    const abs = resolveIn(workspace, rel);
    if (abs.startsWith("error:")) continue;
    let raw: string;
    try {
      const info = await stat(abs);
      if (info.size > MAX_FILE_BYTES) continue;
      raw = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (raw.includes("\0")) continue;
    const fileLines = raw.split(/\r?\n/);
    for (let i = 0; i < fileLines.length; i++) {
      const line = fileLines[i] ?? "";
      if (!re.test(line)) continue;
      lines.push(`${rel}:${i + 1}:${line}`);
      if (lines.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
    }
  }

  if (lines.length === 0) return "(no matches)";
  const extra = truncated ? `\n... truncated at ${MAX_MATCHES} matches` : "";
  return clip(lines.join("\n") + extra);
}
