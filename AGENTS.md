# ez-agent-harness

Minimal coding-agent REPL. Loop lives in `src/index.ts`, HTTP/SSE in `src/llm.ts`, tools in `src/tools.ts`.

- Typecheck with `npx tsc --noEmit`. There is no test runner.
- Do not commit `.env` or print secrets.
- Prefer `edit` on existing files. Use `write_file` only to create.
- `src/test.ts` and `scratch.txt` are throwaway; do not "clean up" the agent source unless asked.
- Bash starts in the workspace but can `cd` out. Do not touch files outside the project.
