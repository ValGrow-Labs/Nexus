# Nexus

**An AI-native development platform.** Pick the kind of work you're doing, open a
workspace, and build with AI helpers alongside your normal development tools.

## How it works in 5 steps

1. Pick a project, then choose your AI helper (a free one is fine).
2. Ask for what you want, in plain words.
3. Look over the suggested changes, then add them to your project.

> **Status: college project, beta.** The shell, the workspace launcher, the workspace
> and project pages and the assistant panel run on real local data. On top of that
> there is a platform core with a sandboxed **execution and agent runtime (B2b)**:
> an AI helper works in a safe copy of a project, its suggested changes are checked by real
> tests in a Docker safe space, and you look them over, keep them and add them to your project yourself.
> AI helpers can run on the Claude CLI you already have installed (your own plan), a **local model through
> Ollama** (loopback only) or a **hosted free-tier model** with your own access key (an API key).
> It was verified end to end on scratch projects with a real Claude turn and a
> real Docker sandbox; use on your own repositories, the local 7B model, the
> hosted free-key runtime (tested against mock servers only) and the migration of
> an existing database are **not yet verified**.
> The honest list of what is and is not proven is in
> [`docs/nexus/platform-core.md`](./docs/nexus/platform-core.md) (Part IV, section 49
> and the known limitations). Execution and agents are off by default.

## Works with free AI

You do not need a paid model to use Nexus's AI helper. It can run on a **free API key** (an access key, in the app's words)
from a hosted provider (Groq or Google Gemini: create a key in the provider's
console and paste it in Settings, where Nexus keeps it encrypted on your computer
and never shows it again), on a **local model through Ollama** that never leaves
your machine, or on the **Claude CLI** if you already have it installed, which is
optional. Whichever you pick, the AI helper's commands run in a Docker safe space with no
internet, so Docker Desktop is required, and free tiers have rate limits that the
provider sets, not Nexus. The hosted-key runtime is built and tested against mock
servers only: it is **not yet verified** with a real provider key. Details and the
honest limits are in [`docs/nexus/platform-core.md`](./docs/nexus/platform-core.md)
(Part IV, sections 62 and 63).

## What works today

- **Launcher.** "What are you working on?" with workspaces for SDE, ML, DL,
  Data Analytics, Research, QA, UI/UX and DevOps, plus *Your Projects*.
- **Projects.** Create or import a local folder. Nexus analyses it
  deterministically (languages, frameworks, tests, git, a code graph, a repo
  health score) and files it under the matching workspace.
- **Agents.** Run the CLI coding agents you already use (Claude Code, Codex and
  others) in real terminals, coordinated through a local hive with a lead agent.
- **Assistant panel.** Sends requests to the lead agent, with the current
  workspace and project attached as context.
- **Files / IDE, terminals, git history**, skills, MCP servers and integrations.
- **Search** with <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> and the assistant with
  <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>J</kbd>; light and dark themes.

## Planned

Saved items with versions and lineage, cross-workspace handoffs, "Turn into App",
builds and deployments, and a sandboxed agent runtime. See
[`docs/superpowers/specs/`](./docs/superpowers/specs/) for the design and the
open follow-ups.

## Development

Requirements: Node.js 18+, npm, and a C/C++ toolchain for the native `node-pty`
addon (Xcode command-line tools on macOS, Visual Studio Build Tools on Windows).
Agents need their own CLIs (for example `claude`) on `PATH`.

```bash
npm install          # postinstall rebuilds node-pty against Electron's ABI
npm run dev          # live-reloading Electron app
npm run typecheck    # node + web TypeScript projects
npm run test:focused # focused test set (includes the Nexus tests)
node --test test/    # full test suite
npm run build        # production build
```

If launch fails with a `NODE_MODULE_VERSION` or "wrong ELF/Mach-O" error, re-run
`npm install` to rebuild `node-pty`.

## Project layout

| Path | Contents |
|---|---|
| `src/main/` | Electron main process: projects, agents and hive, terminals, files, git, skills, integrations, the local database. |
| `src/preload/` | The typed IPC bridge (`window.cth`). |
| `src/renderer/src/nexus/` | The Nexus shell: launcher, workspaces, pages, assistant, command palette. |
| `src/renderer/src/` | Other UI: IDE, terminals, agent views, settings. |
| `src/shared/` | Types and registries shared by main and renderer. |
| `docs/superpowers/` | Specs and implementation plans. |

## Privacy

Official builds send a small set of anonymous usage events (opt-out in
Settings). The full contract is in [`TELEMETRY.md`](./TELEMETRY.md).

## Licence

MIT — see [`LICENSE`](./LICENSE). Nexus is built on an MIT-licensed open-source
agent harness; its copyright notice is kept in `LICENSE`. Some bundled pixel-art
assets are licensed for non-commercial use only — see
[`ATTRIBUTION.md`](./src/renderer/src/assets/ATTRIBUTION.md).

## Credits and disclaimer

- **Upstream.** This project is a fork of
  [`chaitanyagiri/munder-difflin`](https://github.com/chaitanyagiri/munder-difflin)
  by Chaitanya Giri (MIT). The platform core, the execution and agent runtime, the
  local-model runtime and the Nexus UI work were added on top of it as a college
  project by Mohammed Jaasir and contributors; AI coding tools were used to write
  parts of it.
- **Art.** Pixel art is by LimeZu (FREE license, **non-commercial use only**), via
  [`shahar061/the-office`](https://github.com/shahar061/the-office) (ISC). Fonts are
  licensed under the SIL OFL 1.1 ([`THIRD_PARTY_FONTS.md`](./THIRD_PARTY_FONTS.md)).
  This project is not for sale; replace the art before any commercial use.
- **Not affiliated.** This is an unofficial educational project. It is not
  affiliated with, endorsed by or sponsored by NBCUniversal or the makers of *The
  Office* (its sprites and the old "Munder Difflin" name are fan references), nor
  by Anthropic or Ollama. Product names belong to their owners. Nexus does not
  bundle or copy any agent's login: it runs the CLI you installed, or your own local
  model, on your own machine.
- **No warranty.** Provided "as is" under the MIT License. AI helpers can change files;
  look over every suggested change before you keep it or add it to your project.
