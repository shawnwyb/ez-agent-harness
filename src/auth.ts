import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentHome } from "./paths.ts";

export function authFile(): string {
  return path.join(agentHome(), "auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function readAuthFile(): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(authFile(), "utf8");
  } catch (err) {
    if (isEnoent(err)) return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid ${authFile()}`);
  }
  if (!isRecord(parsed)) throw new Error(`invalid ${authFile()}`);
  return parsed;
}

function writeAuthFile(data: Record<string, unknown>): void {
  const file = authFile();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
}

export function readAuthKey(providerId: string): string | undefined {
  const cred = readAuthFile()[providerId];
  if (!isRecord(cred) || cred.type !== "api_key") return undefined;
  if (typeof cred.key !== "string" || cred.key.length === 0) return undefined;
  return cred.key;
}

export function writeAuthKey(providerId: string, key: string): void {
  const data = readAuthFile();
  data[providerId] = { type: "api_key", key };
  writeAuthFile(data);
}

export function deleteAuthKey(providerId: string): boolean {
  const data = readAuthFile();
  if (!(providerId in data)) return false;
  delete data[providerId];
  writeAuthFile(data);
  return true;
}
