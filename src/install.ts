import { lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "ez-agent-harness";
const BIN_NAME = "ezagent";

export function isYes(text: string): boolean {
  const answer = text.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

export async function confirmUnlink(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question("Remove the global ezagent command? [y/N] ", resolve);
    });
    return isYes(answer);
  } finally {
    rl.close();
  }
}

function userPrefix(): string {
  return path.join(os.homedir(), ".local");
}

function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function pkgDir(prefix: string): string {
  return path.join(prefix, "lib", "node_modules", PACKAGE_NAME);
}

function binFile(prefix: string): string {
  return path.join(prefix, "bin", BIN_NAME);
}

function prefixFromBin(bin: string): string {
  return path.dirname(path.dirname(path.resolve(bin)));
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function existsLinkOrFile(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function replaceSymlink(dest: string, target: string): void {
  if (existsLinkOrFile(dest)) {
    if (!isSymlink(dest)) {
      throw new Error(`${dest} exists and is not a symlink`);
    }
    rmSync(dest);
  }
  symlinkSync(target, dest);
}

function removeSymlink(dest: string): { removed: boolean; error?: string } {
  if (!existsLinkOrFile(dest)) return { removed: false };
  if (!isSymlink(dest)) {
    return { removed: false, error: `${dest} is not a symlink; leaving it` };
  }
  try {
    rmSync(dest);
    return { removed: true };
  } catch (err) {
    return { removed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function findLinkedPrefix(): string | null {
  const bins: string[] = [];
  const argv1 = process.argv[1];
  if (argv1 && path.basename(argv1) === BIN_NAME) {
    bins.push(path.resolve(argv1));
  }
  bins.push(binFile(userPrefix()));
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) bins.push(path.join(dir, BIN_NAME));
  }
  for (const bin of bins) {
    if (existsLinkOrFile(bin)) return prefixFromBin(bin);
  }
  return null;
}

export function linkGlobal(): { ok: boolean; message: string } {
  const root = projectRoot();
  const distBin = path.join(root, "dist", "index.js");
  if (!existsLinkOrFile(distBin)) {
    return { ok: false, message: "dist/index.js missing; run npm run build" };
  }
  const prefix = userPrefix();
  const destPkg = pkgDir(prefix);
  const destBin = binFile(prefix);
  try {
    mkdirSync(path.dirname(destPkg), { recursive: true });
    mkdirSync(path.dirname(destBin), { recursive: true });
    replaceSymlink(destPkg, root);
    replaceSymlink(destBin, path.join(destPkg, "dist", "index.js"));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, message: `linked ${destBin}` };
}

export function unlinkGlobal(): { ok: boolean; message: string } {
  const prefix = findLinkedPrefix();
  if (!prefix) {
    return { ok: false, message: "ezagent is not on PATH (nothing to unlink)" };
  }
  const bin = removeSymlink(binFile(prefix));
  const pkg = removeSymlink(pkgDir(prefix));
  const error = bin.error ?? pkg.error;
  if (error) return { ok: false, message: error };
  if (!bin.removed && !pkg.removed) {
    return { ok: false, message: "ezagent is not on PATH (nothing to unlink)" };
  }
  return { ok: true, message: "removed global ezagent" };
}
