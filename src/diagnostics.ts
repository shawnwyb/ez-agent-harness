import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

const DIAG_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const TSC_TIMEOUT_MS = 20_000;
const MAX_DIAG_CHARS = 4_000;

function wantsDiagnostics(rel: string): boolean {
  const base = path.basename(rel);
  if (base === "tsconfig.json") return true;
  return DIAG_EXT.has(path.extname(rel));
}

function killTree(pid: number): void {
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

function clip(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_DIAG_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_DIAG_CHARS)}\n... truncated ${trimmed.length - MAX_DIAG_CHARS} chars`;
}

/** After a successful TS/JS write, run project tsc when tsconfig.json exists. */
export async function afterWriteDiagnostics(
  workspace: string,
  rel: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return null;
  if (!wantsDiagnostics(rel)) return null;
  try {
    await stat(path.join(workspace, "tsconfig.json"));
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const child = spawn("npx", ["--no-install", "tsc", "--noEmit", "--pretty", "false"], {
      cwd: workspace,
      env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
    });

    let out = "";
    let timedOut = false;
    let settled = false;

    const finish = (text: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(text);
    };

    const onAbort = () => {
      if (child.pid) killTree(child.pid);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, TSC_TIMEOUT_MS);

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });

    child.on("error", () => {
      finish(null);
    });

    child.on("close", (code) => {
      if (signal?.aborted) {
        finish(null);
        return;
      }
      if (timedOut) {
        finish("(tsc: timed out)");
        return;
      }
      if (code === 0) {
        finish("(tsc: ok)");
        return;
      }
      const body = clip(out);
      finish(body.length > 0 ? `(tsc: errors)\n${body}` : `(tsc: exit ${code})`);
    });
  });
}
