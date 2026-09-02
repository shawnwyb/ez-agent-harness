# Ez Agent Harness

A from-scratch, lightweight coding agent for the terminal. The loop, providers, tools, and sessions are written here. No external agent SDK. Workspace is the directory you launch from.

Needs Node 22+. Used on macOS. Install from this clone.

## Quick Start

You need an [xAI](https://console.x.ai) or [Anthropic](https://console.anthropic.com) API key.

```bash
git clone https://github.com/shawnwyb/ez-agent-harness
cd ez-agent-harness
npm install
npm run link
```

`npm run link` puts `ezagent` in `~/.local/bin`. If the command is not found, add that directory to your `PATH`.

Then in any folder:

```bash
ezagent
```

First run, in the TUI:

```
/login xai
```

Paste the key on the next line. Same for `/login anthropic`. Type `/help` for the rest of the commands.

In this repo only, `npm start` builds and runs without putting `ezagent` on PATH. After you change the source, run `npm run link` again (or `npm run build` if you already linked).

Remove the command:

```bash
ezagent uninstall
```

Uninstall command does not delete keys or sessions. Those live in `~/.ez-agent` (Pi-style), not in the project directory.

## Acknowledgements

- Inspired by [Pi](https://github.com/earendil-works/pi) & [Oh My Pi](https://github.com/can1357/oh-my-pi)
- Terminal UI via [pi-tui](https://github.com/earendil-works/pi/tree/main/packages/tui)
