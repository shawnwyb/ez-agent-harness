import { linkGlobal } from "./install.js";

const result = linkGlobal();
console.error(result.message);
process.exit(result.ok ? 0 : 1);
