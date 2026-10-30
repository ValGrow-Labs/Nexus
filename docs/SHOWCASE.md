# Showcase: running Nexus live

This is the script for showing Nexus working: an AI agent builds a small project **inside the app**, its change is checked by
real tests in a sandbox, and you review, accept and merge it. It takes about 10 minutes.

## Before you start (once)

| Need | How to check |
|---|---|
| Docker Desktop running (Linux containers) | the launcher starts it if needed |
| The three sandbox images present | `docker images` lists `nexus-local/sde-node`, `sde-python`, `nexus-fwd` (built once with `node tools/nexus-prepare-images.cjs --build`, needs network) |
| About 30 GiB free on `C:` | the launcher warns when it is lower |
| A way for Nexus to build, **any one** of these (nobody needs a paid plan): a **free hosted-model API key** (a few minutes to create in the provider's console; free, fast), a local **Ollama** with `qwen2.5-coder:7b` (free, private, slow and less reliable), or the **Claude CLI** signed in (`claude auth status` in your own terminal; optional, uses your own plan) | Free key: the guide's first option. Ollama: the second. Claude: the third, only if you already have it |
| Node.js and `npm install` done | `npm run typecheck` |

## Start it

```powershell
cd C:\Users\pc\munder-difflin
powershell -ExecutionPolicy Bypass -File tools\showcase.ps1 -Build      # -Build only after code changes
```

The launcher makes a **scratch** data folder and a tiny git project, then opens the real app. Your own Nexus projects and
database are never touched. Close and delete everything afterwards with `tools\showcase.ps1 -Clean`.

## The demo (what to click and say)

1. **Welcome / onboarding.** Click through. In the lead-agent engine step leave **Not now** selected (it is the default): finishing setup starts no program on your computer. The lead agent is the older feature; the demo does not use it.
2. **Create the project.** "Create or import a project", choose the folder the launcher printed
   (`...\nexus-showcase-live\demo-project`). It opens in the **SDE** workspace.
   *Say:* Nexus analyses the project and files it under the right workspace.
3. **Take a repository snapshot** (the repository step in the rail). *Say:* Nexus records exactly which commit the agent starts from.
4. **Choose how Nexus builds for you.** Open **Execution setup** (or press the one button in the agent panel). The guide *Choose how Nexus
   builds for you* lists three options, free first. **Free online AI**: press *Add my key*, paste the free key under *AI provider keys* in
   Settings, save it, come back, pick the provider and a model and press **Use this runtime**. Or **On this computer**: start the local model
   server, pick the model and press **Use this runtime**. Or, only if you already have it, **a plan you already have** (the Claude CLI) when
   it reads *Ready*. *Say:* the permission is once, revocable, and allows only the destinations it names (the provider's host for a free
   key, `127.0.0.1:11434` for the local model, the CLI's own host for the third); caps are $2 per turn and $10 per day.
5. **Ask the agent.** In the agent panel paste:

   > Build a tiny weather-prediction model in pure Python (standard library only) in `src/pytest_app/weather.py`:
   > `make_dataset(days, seed)`, `train(series, lags=3)` by least squares, `predict(weights, last_days)`,
   > `mae(weights, series, lags=3)`. Add at least six pytest tests in `tests/test_weather.py` and run them with
   > `python -m pytest -q -B`. When they pass, register the change.

   (With `-Fixture node-test-app` use a JavaScript task instead, for example a `greet(name)` module with `node:test` tests.)
6. **First approval.** The turn may wait for *"Let Nexus write hidden refs in this repository"*. Approve it (**Approve once**; it
   asks twice). *Say:* the agent works on hidden git refs and a private copy; your branch and files are not touched.
7. **Watch the session log** (30 s to a few minutes). *Say:* every tool call is recorded; commands run in a container with
   **no network**; the agent only has the files in its own worktree.
8. **Review.** Open **Changes**. Show the diff and the checks: tests really ran in Docker, merges cleanly, in scope,
   secret scan. *Say:* the agent cannot approve its own work.
9. **Approve, Accept, then "Merge accepted work"** (a confirmation dialog names the exact commit your branch moves to).
   *Say:* only now does your branch change, and only as a fast-forward you confirmed.
10. **Show the result.** In a terminal:
    `cd <demo-project>; git log --oneline; set PYTHONPATH=src; python -B -m pytest -q -p no:cacheprovider tests`.

## Talking points

- **What it is:** a workbench where agents work in isolated, recorded, revocable ways, and a human reviews every change.
- **Safety:** capability tokens per turn; sandbox with no network, one bind mount, dropped capabilities; secret scan on every
  change; accept never touches your branch; merge is a confirmed fast-forward; egress limited to one host.
- **Runtimes:** free hosted-model APIs (your own free key), a local Ollama model, or the Claude CLI if you have it; one at a time, chosen in the guide in the setup sheet. Nexus works without any Claude plan.
- **Honest limits** (also in `docs/nexus/platform-core.md`, Part IV): verified end to end on scratch projects with real Claude
  and real Docker; use on your own repositories, the local 7B model and migrating an existing database are not yet verified.

## If something goes wrong

| Symptom | Fix |
|---|---|
| "The agent's turn failed" right after sending | take the repository snapshot first (step 3), then send again |
| Turn sits on "Waiting" | open the strip above the panel and approve the repository write |
| The setup row says Docker/disk problem | start Docker Desktop; free space on `C:` |
| The Claude option says not installed or not signed in | it is optional: use a free key or the local model instead, or run `claude` once in a terminal and sign in |
| Free online AI says it needs a key, or the key is rejected | press *Add my key*, paste the key exactly as the provider shows it, save, then check again |
| The local model option says the server is not running or has no model | start Ollama and `ollama pull qwen2.5-coder:7b`, then press *Check again* |
| Anything else | `tools\showcase.ps1 -Clean`, then start again (a fresh scratch folder every time) |

Keep a recorded run to fall back on: the merged result folder of one good run (the project folder after step 10) and a few screenshots of steps 4, 7, 8 and 9. (Step 4's screenshot is the guide.)
