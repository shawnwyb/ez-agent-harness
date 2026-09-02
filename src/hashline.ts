/** Whole-file snapshot tag + numbered lines. OMP idea, no patch language. */

export type SplitFile = {
  lines: string[];
  endedWithNl: boolean;
};

export function normalizeText(text: string): string {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return stripped.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** FNV-1a of normalized text, 4 uppercase hex — same width as OMP's tag. */
export function fileHash(text: string): string {
  const norm = normalizeText(text);
  let h = 2166136261;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, "0").slice(0, 4);
}

export function splitFile(text: string): SplitFile {
  const norm = normalizeText(text);
  if (norm.length === 0) return { lines: [], endedWithNl: false };
  const endedWithNl = norm.endsWith("\n");
  const parts = norm.split("\n");
  if (endedWithNl && parts[parts.length - 1] === "") parts.pop();
  return { lines: parts, endedWithNl };
}

export function joinFile(file: SplitFile): string {
  if (file.lines.length === 0) return file.endedWithNl ? "\n" : "";
  return file.lines.join("\n") + (file.endedWithNl ? "\n" : "");
}

export function formatRead(rel: string, text: string): string {
  const tag = fileHash(text);
  const header = `[${rel}#${tag}]`;
  const { lines } = splitFile(text);
  if (lines.length === 0) return `${header}\n(empty file)`;
  const body = lines.map((line, i) => `${i + 1}:${line}`).join("\n");
  return `${header}\n${body}`;
}

export function parseTag(raw: string): string | null {
  const trimmed = raw.trim();
  const fromHeader = /^\[(?:[^#\]]+)#([0-9A-Fa-f]{4})\]$/.exec(trimmed);
  const hex = fromHeader?.[1] ?? (/^[0-9A-Fa-f]{4}$/.exec(trimmed)?.[0] ?? null);
  return hex ? hex.toUpperCase() : null;
}

export function parseLine(value: unknown, label: string): number | string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === "string") {
    const digits = /^(\d+)/.exec(value.trim());
    if (digits?.[1]) {
      const n = Number(digits[1]);
      if (n >= 1) return n;
    }
  }
  return `error: ${label} must be a 1-based line number from read_file`;
}

export function splitReplacement(text: string): string[] {
  if (text.length === 0) return [];
  const norm = normalizeText(text);
  const parts = norm.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function snippet(rel: string, text: string, around: number, span = 4): string {
  const { lines } = splitFile(text);
  const tag = fileHash(text);
  if (lines.length === 0) return `[${rel}#${tag}]\n(empty file)`;
  const from = Math.max(0, around - span);
  const to = Math.min(lines.length, around + span + 1);
  const body = lines
    .slice(from, to)
    .map((line, i) => `${from + i + 1}:${line}`)
    .join("\n");
  return `[${rel}#${tag}]\n${body}`;
}

export type FileTagEdit = {
  tag: string;
  start: number;
  end: number;
  new_string: string;
};

export function applyFileTag(
  rel: string,
  text: string,
  edit: FileTagEdit,
): { next: string; tag: string } | string {
  const live = fileHash(text);
  if (live !== edit.tag) {
    return `error: stale tag ${edit.tag} for ${rel} (now ${live}). Re-read.\n${snippet(rel, text, edit.start - 1)}`;
  }
  const file = splitFile(text);
  if (edit.start > edit.end) {
    return `error: start ${edit.start} is after end ${edit.end}`;
  }
  if (edit.start > file.lines.length || edit.end > file.lines.length) {
    return `error: lines ${edit.start}-${edit.end} past end of ${rel} (${file.lines.length} lines)\n${snippet(rel, text, file.lines.length - 1)}`;
  }
  const next = joinFile({
    lines: [
      ...file.lines.slice(0, edit.start - 1),
      ...splitReplacement(edit.new_string),
      ...file.lines.slice(edit.end),
    ],
    endedWithNl: file.endedWithNl,
  });
  return { next, tag: fileHash(next) };
}

export function previewRead(rel: string, text: string, startLine: number, newLineCount: number): string {
  const { lines } = splitFile(text);
  const tag = fileHash(text);
  const header = `[${rel}#${tag}]`;
  if (lines.length === 0) return `${header}\n(empty file)`;
  const from = Math.max(0, startLine - 2);
  const to = Math.min(lines.length, startLine - 1 + newLineCount + 2);
  const body = lines
    .slice(from, to)
    .map((line, i) => `${from + i + 1}:${line}`)
    .join("\n");
  return `${header}\n${body}`;
}
