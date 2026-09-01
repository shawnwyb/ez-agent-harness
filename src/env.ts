import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function loadIfExists(file: string): void {
  if (!existsSync(file)) return;
  process.loadEnvFile(file);
}

// Existing process.env wins. Cwd .env wins over ~/.ez-agent/.env.
loadIfExists(path.join(process.cwd(), ".env"));
loadIfExists(path.join(os.homedir(), ".ez-agent", ".env"));
