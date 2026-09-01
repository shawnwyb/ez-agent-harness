import { readdir, stat } from "node:fs/promises";
import { read_file, resolveInWorkspace } from "./tools.js";

const SKIP_DIR = new Set(["node_modules", ".git", ".ez-agent"]);

export type ExpandResult = {
  content: string;
  notices: string[];
};

function looksLikePath(rel: string): boolean {
  return rel.includes("/") || rel.includes(".");
}

function stripTrailingPunct(rel: string): string {
  return rel.replace(/[.,;:!?)]+$/, "");
}

function atPaths(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const re = /(^|\s)@([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[2];
    if (!raw) continue;
    const rel = stripTrailingPunct(raw);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    found.push(rel);
  }
  return found;
}

export async function expandAtFiles(text: string): Promise<ExpandResult> {
  const notices: string[] = [];
  const blocks: string[] = [];

  for (const rel of atPaths(text)) {
    const resolved = resolveInWorkspace(rel);
    if (resolved.startsWith("error:")) {
      if (looksLikePath(rel)) notices.push(`(no file ${rel})`);
      continue;
    }
    try {
      const info = await stat(resolved);
      if (info.isDirectory()) {
        notices.push(`(${rel} is a directory)`);
        continue;
      }
    } catch {
      if (looksLikePath(rel)) notices.push(`(no file ${rel})`);
      continue;
    }
    const body = await read_file(rel);
    blocks.push(`<file path="${rel}">\n${body}\n</file>`);
    notices.push(`(attached ${rel})`);
  }

  if (blocks.length === 0) return { content: text, notices };
  return { content: `${text}\n\n${blocks.join("\n\n")}`, notices };
}

/** Prefix of the path token under the cursor, or null if tab should not complete. */
export function completionPrefix(line: string): string | null {
  const at = /(?:^|\s)@([^\s]*)$/.exec(line);
  if (at?.[1] !== undefined) return at[1];
  if (line.startsWith("/")) return null;
  const pathish = /(?:^|\s)((?:\.\.?\/|[^\s]*\/)[^\s]*)$/.exec(line);
  return pathish?.[1] ?? null;
}

function splitPrefix(prefix: string): { dir: string; base: string } {
  const norm = prefix.replaceAll("\\", "/");
  if (norm.endsWith("/")) {
    return { dir: norm.slice(0, -1) || ".", base: "" };
  }
  const slash = norm.lastIndexOf("/");
  if (slash === -1) return { dir: ".", base: norm };
  return { dir: norm.slice(0, slash) || ".", base: norm.slice(slash + 1) };
}

function relJoin(dir: string, name: string): string {
  if (dir === ".") return name;
  return `${dir.replace(/\/$/, "")}/${name}`;
}

export async function completePath(line: string): Promise<[string[], string]> {
  const prefix = completionPrefix(line);
  if (prefix === null) return [[], ""];

  const { dir, base } = splitPrefix(prefix);
  const absDir = resolveInWorkspace(dir);
  if (absDir.startsWith("error:")) return [[], prefix];

  let ents;
  try {
    ents = await readdir(absDir, { withFileTypes: true });
  } catch {
    return [[], prefix];
  }

  const hits: string[] = [];
  for (const ent of ents) {
    if (SKIP_DIR.has(ent.name)) continue;
    if (!base.startsWith(".") && ent.name.startsWith(".")) continue;
    if (base && !ent.name.startsWith(base)) continue;
    const rel = relJoin(dir, ent.name);
    hits.push(ent.isDirectory() ? `${rel}/` : rel);
  }
  hits.sort((a, b) => a.localeCompare(b));
  return [hits, prefix];
}
