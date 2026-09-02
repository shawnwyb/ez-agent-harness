import { existsSync } from "node:fs";
import path from "node:path";
import { agentHome } from "./paths.ts";

function loadIfExists(file: string): void {
  if (!existsSync(file)) return;
  process.loadEnvFile(file);
}

// Existing process.env wins. Cwd and package .env are not read.
loadIfExists(path.join(agentHome(), ".env"));
