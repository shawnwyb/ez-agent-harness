import {
  CombinedAutocompleteProvider,
  Editor,
  ProcessTerminal,
  TUI,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type SelectListTheme,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { WORKSPACE } from "./tools.ts";

const TRACE_ARG_CHARS = 80;
const TRACE_RESULT_LINES = 8;

export const HELP = `commands:
  /help
  /model [id]              this session
  /model default [id]      save startup default
  /new                     new session (keeps default model)
  /clear                   clear the screen; context stays
  /sessions
  /resume [id]
  /compact [focus]         summarize old turns; file keeps them
  /delete current | <id> | all
  /uninstall               remove the global ezagent command
  @path                    attach a workspace file; tab completes paths
  /exit, /quit
  Ctrl+C                   cancel a run; at the prompt, quit
`;

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "list commands" },
  { name: "model", description: "this session", argumentHint: "[id]" },
  { name: "new", description: "new session" },
  { name: "clear", description: "clear the screen; context stays" },
  { name: "sessions", description: "list sessions" },
  { name: "resume", description: "resume a session", argumentHint: "[id]" },
  { name: "compact", description: "summarize old turns", argumentHint: "[focus]" },
  { name: "delete", description: "delete sessions", argumentHint: "current | <id> | all" },
  { name: "uninstall", description: "remove the global ezagent command" },
  { name: "exit", description: "quit" },
  { name: "quit", description: "quit" },
];

export type ViewBlock =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; args: string; result: string }
  | { kind: "note"; text: string };

const identity = (text: string): string => text;

const selectTheme: SelectListTheme = {
  selectedPrefix: (text) => `\x1b[36m${text}\x1b[0m`,
  selectedText: (text) => `\x1b[7m${text}\x1b[27m`,
  description: (text) => `\x1b[2m${text}\x1b[22m`,
  scrollInfo: (text) => `\x1b[2m${text}\x1b[22m`,
  noMatch: (text) => `\x1b[2m${text}\x1b[22m`,
};

const editorTheme: EditorTheme = {
  borderColor: (text) => `\x1b[90m${text}\x1b[0m`,
  selectList: selectTheme,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function formatArgs(argsJson: string): string {
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

function paint(text: string, width: number, color: (s: string) => string): string[] {
  if (width < 1) return [];
  const wrapped = wrapTextWithAnsi(text.length > 0 ? text : " ", width);
  return wrapped.map((line) => truncateToWidth(color(line), width));
}

class Transcript implements Component {
  blocks: ViewBlock[] = [];

  clear(): void {
    this.blocks = [];
  }

  invalidate(): void {}

  render(width: number): string[] {
    const out: string[] = [];
    for (const block of this.blocks) {
      if (block.kind === "user") {
        out.push(...paint(`you > ${block.text}`, width, (s) => `\x1b[36m${s}\x1b[0m`));
      } else if (block.kind === "assistant") {
        out.push(...paint(block.text.length > 0 ? block.text : "…", width, identity));
      } else if (block.kind === "tool") {
        const head = `  ${block.name}  ${formatArgs(block.args)}`;
        const body = clipResult(block.result)
          .split("\n")
          .map((line, i) => (i === 0 ? `  -> ${line}` : `     ${line}`))
          .join("\n");
        out.push(...paint(`${head}\n${body}`, width, (s) => `\x1b[2m${s}\x1b[0m`));
      } else {
        out.push(...paint(block.text, width, (s) => `\x1b[33m${s}\x1b[0m`));
      }
      out.push("");
    }
    return out;
  }
}

class Footer implements Component {
  text = "";

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 1) return [""];
    return [truncateToWidth(this.text, width)];
  }
}

export type Screen = {
  waitLine: () => Promise<string>;
  note: (text: string) => void;
  user: (text: string) => void;
  assistantDelta: (delta: string) => void;
  tool: (name: string, argsJson: string, result: string) => void;
  setFooter: (text: string) => void;
  clearView: () => void;
  stop: () => void;
};

export function startScreen(handlers: {
  onAbort: () => boolean;
  onQuit: () => void;
}): Screen {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const transcript = new Transcript();
  const footer = new Footer();
  const editor = new Editor(tui, editorTheme);
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(SLASH_COMMANDS, WORKSPACE),
  );

  const pending: string[] = [];
  let waiting: ((line: string) => void) | null = null;

  editor.onSubmit = (text) => {
    if (!text) return;
    editor.addToHistory(text);
    tui.requestRender();
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(text);
      return;
    }
    pending.push(text);
  };

  tui.addChild(transcript);
  tui.addChild(footer);
  tui.addChild(editor);
  tui.setFocus(editor);

  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      if (handlers.onAbort()) return { consume: true };
      handlers.onQuit();
      return { consume: true };
    }
    if (matchesKey(data, "escape") && handlers.onAbort()) {
      return { consume: true };
    }
    return undefined;
  });

  tui.start();

  function paintScreen(): void {
    tui.requestRender();
  }

  return {
    waitLine: () => {
      const next = pending.shift();
      if (next !== undefined) return Promise.resolve(next);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    note: (text) => {
      transcript.blocks.push({ kind: "note", text });
      paintScreen();
    },
    user: (text) => {
      transcript.blocks.push({ kind: "user", text });
      paintScreen();
    },
    assistantDelta: (delta) => {
      const last = transcript.blocks[transcript.blocks.length - 1];
      if (last?.kind === "assistant") {
        last.text += delta;
      } else {
        transcript.blocks.push({ kind: "assistant", text: delta });
      }
      paintScreen();
    },
    tool: (name, argsJson, result) => {
      transcript.blocks.push({ kind: "tool", name, args: argsJson, result });
      paintScreen();
    },
    setFooter: (text) => {
      footer.text = text;
      paintScreen();
    },
    clearView: () => {
      transcript.clear();
      paintScreen();
    },
    stop: () => {
      tui.stop();
    },
  };
}
