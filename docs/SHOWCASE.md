# Showcase: running Nexus live

This is the script for showing Nexus working: an AI helper builds a small project **inside the app**, its suggested changes are checked by
real tests in a safe space (Docker), and you look them over, keep them and add them to your project. It takes about 10 minutes.

The app uses plain words. The code words are in `docs/nexus/platform-core.md` (Part IV, "Names in the app and names in this part"), and the full
word list is in [`docs/GLOSSARY.md`](./GLOSSARY.md).

## Before you start (once)

| Need | How to check |
|---|---|
| Docker Desktop running (Linux containers) | the launcher starts it if needed |
| The three safe-space kits present | `docker images` lists `nexus-local/sde-node`, `sde-python`, `nexus-fwd` (built once with `node tools/nexus-prepare-images.cjs --build`, needs network; in the app the sheet "Get this computer ready" has the button "Prepare the safe-space kits") |
| About 30 GiB free on `C:` | the launcher warns when it is lower; the sheet shows "Space on your disk" |
| A way for Nexus to build, **any one** of these (nobody needs a paid plan): **Free online AI** with a free access key (a few minutes to create on the AI service's own website; free, fast), **AI on this computer** with a local **Ollama** and `qwen2.5-coder:7b` (free, private, slow and less reliable), or **Your own plan**, the Claude CLI signed in (`claude auth status` in your own terminal; optional, uses your own plan) | Free key: the first option in "Choose your AI helper". Ollama: the second. Your own plan: the third, only if you already have it |
| Node.js and `npm install` done | `npm run typecheck` |

## Start it

```powershell
cd C:\Users\pc\munder-difflin
powershell -ExecutionPolicy Bypass -File tools\showcase.ps1 -Build      # -Build only after code changes
```

The launcher makes a **scratch** data folder and a tiny git project, then opens the real app. Your own Nexus projects and
database are never touched. Close and delete everything afterwards with `tools\showcase.ps1 -Clean`.

## The demo (what to click and say)

1. **Welcome / onboarding.** Click through. In the lead AI helper step leave **Not now** selected (it is the default): finishing setup starts no program on your computer. The lead AI helper is the older feature; the demo does not use it.
2. **Create the project.** "Create or import a project", choose the folder the launcher printed
   (`...\nexus-showcase-live\demo-project`). It opens in the **Software** workspace (code: `sde`).
   *Say:* Nexus looks at the project and files it under the right workspace.
3. **Save a starting point** (the third step of "Your first build"). *Say:* Nexus remembers exactly which version of your project the AI helper starts from.
4. **Follow "Your first build".** Open **Get this computer ready** (or press the one button in the AI helper panel). The checklist "Your first build"
   has three steps: *Get this computer ready*, *Choose your AI helper*, *Save a starting point*. In **Choose your AI helper** pick one of three ways,
   free first. **Free online AI**: press *Add my key*, paste the free key under *Access keys* in Settings (Agents & Models), save it, come back,
   pick the AI service and a model and press **Use this AI service**. Or **AI on this computer**: start the local model server, pick the model and
   press **Use this AI service**. Or, only if you already have it, **Your own plan** (the Claude CLI) when it reads *Ready*. *Say:* the internet permission is
   given once, can be taken back, and allows only the addresses it names (the AI service's address for a free key, `127.0.0.1:11434` for the local
   model, the program's own address for the third); the limits are $2 per request and $10 per day.
5. **Ask the AI helper.** In the AI helper panel paste:

   > Build a tiny weather-prediction model in pure Python (standard library only) in `src/pytest_app/weather.py`:
   > `make_dataset(days, seed)`, `train(series, lags=3)` by least squares, `predict(weights, last_days)`,
   > `mae(weights, series, lags=3)`. Add at least six pytest tests in `tests/test_weather.py` and run them with
   > `python -m pytest -q -B`. When they pass, register the change.

   (With `-Fixture node-test-app` use a JavaScript task instead, for example a `greet(name)` module with `node:test` tests.)
6. **First question: "Let Nexus keep hidden Nexus notes in your project".** The request may wait for it. Press **Allow once** (it
   asks twice). *Say:* the AI helper works in a safe copy of your project and Nexus keeps its own notes in a small hidden area; your main version and your files are not touched.
7. **Watch the conversation log** (30 s to a few minutes). *Say:* every step the AI helper takes is recorded; commands run in a safe space with
   **no internet**; the AI helper only has the files in its own safe copy.
8. **Look over the suggested changes.** Open **Changes**. Show what changed and the checks: tests really ran in Docker, the changes fit your project, only allowed files,
   no secrets. *Say:* the AI helper cannot say "Looks good" to its own work.
9. **Press "Looks good", then "Keep these changes", then "Add to my project"** (a confirmation window names the exact version your project moves to; Cancel is the default).
   *Say:* only now does your project change, and only as a step you confirmed.
10. **Show the result.** In a terminal:
    `cd <demo-project>; git log --oneline; set PYTHONPATH=src; python -B -m pytest -q -p no:cacheprovider tests`.

## Talking points

- **What it is:** a workbench where AI helpers work in safe, recorded copies of your project, and a person looks over every change.
- **Safety:** a one-use pass per request; a safe space with no internet, one shared folder, dropped capabilities; a secret scan on every
  change; "Keep these changes" never touches your project; "Add to my project" is a step you confirm in a separate window; internet limited to one address.
- **AI services:** free online AI (your own free access key), AI on this computer (a local Ollama model), or your own plan (the Claude CLI) if you have it; one at a time, chosen in "Choose your AI helper". Nexus works without any Claude plan.
- **Honest limits** (also in `docs/nexus/platform-core.md`, Part IV): verified end to end on scratch projects with real Claude
  and real Docker; use on your own repositories, the local 7B model, free online AI with a real key and migrating an existing database are not yet verified.

## If something goes wrong

The sentences below are what the app says (the exact text is in `src/renderer/src/nexus/data/errorCopy.ts`).

| What you see | What to do |
|---|---|
| "Nexus has not saved a starting point for this project yet. Save one first." right after sending | press **Save a starting point** (step 3), then send again |
| The request sits on "Waiting for your OK" | open the question above the panel and press **Allow once** |
| "Docker is not running. Start Docker Desktop and try again." or "There is not enough free space on your disk for this. Free some space, then try again." | start Docker Desktop; free space on `C:`, then press *Check again* in "Get this computer ready" |
| "Your AI program is not installed on this computer." or "Your AI program is not signed in. Sign in with it yourself, then press Check again." | it is optional: use Free online AI or AI on this computer instead, or run `claude` once in a terminal and sign in |
| "Add your access key in Settings first." or "The AI service did not accept your access key. Check it in Settings and enter it again." | press *Add my key*, paste the key exactly as the AI service shows it, save, then check again |
| "The program that runs AI on this computer is not running. Start it, then check again in “Get this computer ready”." | start Ollama and `ollama pull qwen2.5-coder:7b`, then press *Check again* |
| "The AI helper needs your internet permission before it can work. Open “Get this computer ready” to allow it." | open "Get this computer ready" and press *Give permission* |
| Anything else | `tools\showcase.ps1 -Clean`, then start again (a fresh scratch folder every time) |

Keep a recorded run to fall back on: the merged result folder of one good run (the project folder after step 10) and a few screenshots of steps 4, 7, 8 and 9. (Step 4's screenshot is the "Choose your AI helper" guide.)
