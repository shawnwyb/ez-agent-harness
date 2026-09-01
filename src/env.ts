import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function loadIfExists(file: string): void {
  if (!existsSync(file)) return;
  process.loadEnvFile(file);
}

// Existing process.env wins. Cwd and package .env are not read.
loadIfExists(path.join(os.homedir(), ".ez-agent", ".env"));
