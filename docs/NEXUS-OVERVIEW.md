# Nexus: the complete overview

Nexus is a desktop app where an AI helper builds things for you in a **safe copy of your project**, and nothing reaches your real files until **you** have looked at it and said yes. It works with free online AI, an AI running on your own computer, or a plan you already pay for, so anyone can use it for free.

This page describes what Nexus is, how it works, what has been verified, and what has not. It is written to be quoted in reports and papers: every claim here is either something the code does or is marked as not verified.

---

## 1. The problem

AI coding tools usually (a) change your real files while you watch, (b) are tied to one company's AI or a paid plan, and (c) give you little proof that the result works or that it stayed inside safe limits. That is hard for beginners and risky for everyone.

## 2. The idea

1. **Safe copy.** The AI works in a separate copy of your project. Your files and your project's main version stay untouched.
2. **You decide.** Every change goes through a short review: **Looks good**, **Keep these changes**, **Add to my project**.
3. **Proof, not promises.** Your tests run automatically in a closed "safe space" with no network, and the result is part of the review. Common secret keys are scanned for.
4. **Any AI, free by default.** Free online AI (a key you create yourself), an AI on your computer, or your own plan. One at a time, chosen by you.
5. **Plain words.** The screens avoid developer jargon so a newcomer can follow them.

## 3. What a person does (the flow)

1. **Start.** Pick the kind of work and create or open a project (a folder on your computer).
2. **Get this computer ready.** A three-step checklist: prepare the safe space (needs Docker), choose your AI helper, save a starting point.
3. **Ask.** Describe the change you want in the AI helper chat on the right.
4. **Watch.** The helper reads and writes files in its safe copy and runs your tests in the safe space. The chat shows what it replies and what it is doing.
5. **Review.** The suggested changes appear with what changed and the checks. Press Looks good, then Keep these changes, then Add to my project. The last step shows a confirmation window naming the exact version your project will move to.
6. **Undo or iterate.** Ask for different changes and the helper tries again; the new version is linked to the old one.

## 4. Main concepts

| Name in the app | What it is |
|---|---|
| **Workspace** | A set of tools for one kind of work (Software works today; Machine learning, Deep learning, Data analytics, Research, Testing, UI/UX and DevOps are defined and show "Coming later"). |
| **Project** | A folder Nexus watches: languages, tests, git state, a health score. |
| **Saved items** | Everything a project produces: starting points, suggested changes, test results, builds. Each knows what it was made from. |
| **Suggested changes** | The edits an AI helper proposes. Nothing changes in your files until you add them. |
| **AI helper** | The AI that works in the safe copy. |
| **AI service** | What does the thinking: Free online AI, AI on this computer, or Your own plan. |
| **Internet permission** | The one online address the helper may talk to, granted once and revocable. |
| **Safe space** | A closed container on your computer where code runs with no network. |

## 5. How it is built

**Platform.** An Electron desktop app (TypeScript, React, zustand) with a main process, a preload bridge and a renderer, plus a separate **runner** process for work that touches git, Docker and the AI helpers.

**Data.** A local SQLite database. Records are append-only where it matters (activity, reviews, accepts), with a tamper-evident activity chain. Execution and agent features live in database versions 9 and 10, which are **off by default** and opt-in; migrations take a verified backup first and can be restored.

**The runner and the AI helpers.** The runner starts one turn at a time, keeps a loopback server that offers the helper a small set of tools (read and write files in its safe copy, run a command in the safe space, hand in the finished changes), and checks every call against a **capability token** that exists only for that turn.

**Git engine.** Nexus keeps its work under hidden git references. The helper's work is a commit on its own reference; accepting moves a Nexus-only reference; "Add to my project" is a confirmed fast-forward that refuses if your files have unsaved changes. Nexus never rewrites your checked-out branch or files before that confirmation.

**Safe space (Docker).** Test commands run in a container with no network, one writable folder (the safe copy), dropped privileges, a read-only root and resource limits. This is why Docker Desktop is required.

**Three AI runtimes**, all behind one interface and chosen in the setup sheet:

| Runtime | How it works | Network it may use |
|---|---|---|
| **Claude CLI** | Runs the user's own installed Claude CLI | `api.anthropic.com:443` only, through a consent-bound proxy |
| **Local model** (Ollama) | A tool-calling loop against a local server | Loopback only (`127.0.0.1:11434`) |
| **Hosted free API** (Groq, Gemini) | An OpenAI-compatible client with free-tier handling | The chosen provider's host only, through the consent-bound proxy, HTTPS only |

A scripted runtime exists for tests. The user's API key is stored only in the app's encrypted store, handed to the runner in memory for one turn, and never logged, stored in the database, or sent to the screen.

## 6. Safety design, in short

- The AI never works in your real files.
- Every command runs with no network in the safe space; the helper's own connection is limited to one consented address.
- The permission is once, revocable, and capped (for example up to $2 per request and $10 per day, a number of requests per hour, one at a time).
- A review cannot be skipped: "Looks good" fails closed unless the whole preview is shown; "Keep" needs a prior approval; "Add to my project" needs the confirmation window.
- Secrets are scanned for before anything can be approved.
- Everything that happens is recorded.

## 7. Verification (what has been checked, and how)

- **Automated tests:** about 264 test files; the full Node 20 run passes except 11 known Windows-specific failures that were failing before this work. The database-backed suite (62 files) passes. A real-Docker suite passes: container isolation, cancel, restart recovery, real `node --test` and `pytest` runs.
- **Real runs:** one real Claude turn through the whole pipeline on a scratch project (about 25 seconds, about $0.14) merged and re-tested clean. The hosted free-API runtime answered a real request with a real Groq key. A weather-prediction project was built and merged through the real pipeline.
- **The interface** was clicked through on scratch data and rebuilt several times from real screenshots.

## 8. What has not been verified

- Use on a real, large repository, or by other people (no user study yet).
- A full real build with a free key from end to end (a greeting worked; a full change set has not been run).
- The local 7B model finishing a task (it has not).
- Migrating an existing real database to the new version.
- Provider quirks (Groq tool-call errors, Gemini schema handling, rate-limit wording) are unconfirmed against the live services.
- Workspaces other than Software are not delivered.

## 9. Known limits

- Docker Desktop is required for the safe space, which is a barrier for casual users.
- Free AI services have rate limits and daily quotas; a turn may pause or end.
- A small local model is slow and less reliable than a large hosted one.
- Switching AI service means revoking the permission and granting the new one.
- The UI is in English only.

## 10. Size and history

About 584 TypeScript files (about 128,000 lines), 1,084 commits by 13 contributors. Built on the open-source base `chaitanyagiri/munder-difflin` (MIT), with the platform core, execution and agent runtime, the local and hosted runtimes, and the plain-words interface added as a college project.

## 11. Licence and credits

MIT for the code. Pixel art is by LimeZu (free version, **non-commercial use only**) via `shahar061/the-office` (ISC). Fonts are under the SIL OFL 1.1. Not affiliated with NBCUniversal, Anthropic, Google, Groq or Ollama; product names belong to their owners.

## 12. Ideas for what comes next

Race several AIs on one request and compare the results; a second AI that reviews the first one's work; a "Proof Card" and one-click undo with an exportable build report; a lesson with every change (Learn as you build); a lighter safe space that does not need Docker; the other workspaces.
