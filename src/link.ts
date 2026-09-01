import { linkGlobal } from "./install.ts";

const result = linkGlobal();
console.error(result.message);
process.exit(result.ok ? 0 : 1);
