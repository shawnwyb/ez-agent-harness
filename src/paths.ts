import { copyFile, mkdir, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function agentHome(): string {
  return path.join(os.homedir(), ".ez-agent");
}

/** Pi-style: /Users/foo/bar → --Users-foo-bar-- */
export function encodeCwd(workspace: string): string {
  const resolved = path.resolve(workspace);
  const dashed = resolved.replace(/[/\\:]+/g, "-").replace(/^-/, "");
  return `--${dashed}--`;
}

export function sessionDir(workspace: string): string {
  return path.join(agentHome(), "sessions", encodeCwd(workspace));
}

export function settingsFile(workspace: string): string {
  return path.join(sessionDir(workspace), "settings.json");
}

export function legacyAgentDir(workspace: string): string {
  return path.join(path.resolve(workspace), ".ez-agent");
}

export function legacySessionDir(workspace: string): string {
  return path.join(legacyAgentDir(workspace), "sessions");
}

export function legacySettingsFile(workspace: string): string {
  return path.join(legacyAgentDir(workspace), "settings.json");
}

export async function ensureAgentDir(dir: string): Promise<void> {
  await mkdir(agentHome(), { recursive: true, mode: 0o700 });
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

async function moveFile(from: string, to: string): Promise<void> {
  if (path.resolve(from) === path.resolve(to)) return;
  await ensureAgentDir(path.dirname(to));
  try {
    await stat(to);
    await unlink(from);
    return;
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  try {
    await rename(from, to);
  } catch (err) {
    if (isEnoent(err)) return;
    await copyFile(from, to);
    await unlink(from);
  }
}

async function rmdirIfEmpty(dir: string): Promise<void> {
  try {
    const names = await readdir(dir);
    if (names.length > 0) return;
    await rmdir(dir);
  } catch {
    // missing or not empty
  }
}

async function migrateJsonlDir(fromDir: string, destDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(fromDir);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    await moveFile(path.join(fromDir, name), path.join(destDir, name));
  }
  await rmdirIfEmpty(fromDir);
}

/** Pull leftover jsonl out of ~/.ez-agent/sessions/ into the encoded cwd bucket. */
async function migrateFlatHomeSessions(workspace: string): Promise<void> {
  await migrateJsonlDir(path.join(agentHome(), "sessions"), sessionDir(workspace));
}

/**
 * Move cwd/.ez-agent into ~/.ez-agent/sessions/--encoded-cwd--/.
 * Skips when cwd is $HOME (that path is already agent home).
 */
export async function migrateLegacyProjectDir(workspace: string): Promise<void> {
  const legacy = legacyAgentDir(workspace);
  if (path.resolve(legacy) === path.resolve(agentHome())) {
    await migrateFlatHomeSessions(workspace);
    return;
  }

  await migrateJsonlDir(legacySessionDir(workspace), sessionDir(workspace));

  try {
    await moveFile(legacySettingsFile(workspace), settingsFile(workspace));
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  await rmdirIfEmpty(legacySessionDir(workspace));
  await rmdirIfEmpty(legacy);
}
