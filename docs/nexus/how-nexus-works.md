# How Nexus Works

Nexus is a desktop app that takes one sentence describing a piece of work, decides which kind of work it is, and hands it to a team of AI coding agents running on your own computer. You then review the exact changes they made.

**Nexus does not write the code itself.** It routes the work, coordinates a team of real AI coding tools, and shows you the real result to approve.

---

## The idea in one picture

Think of Nexus as a small office. You are the manager, the AI agents are the employees, and Nexus is the building: the front desk, the mailroom and the filing cabinet.

```
YOU write a note
   ↓
FRONT DESK counts clue words → "Machine Learning, 7 points"
   ↓  (attaches a label: department + project)
IN-TRAY waits until the team lead is free
   ↓
TEAM LEAD (an AI in a terminal) plans → writes messages to its outbox
   ↓
MAILROOM (every 1.5 s) delivers the messages to the helpers' inboxes
   ↓
HELPERS (AIs in terminals) edit files and run tests
   ↓  (they keep reporting to reception: "working… done")
YOU see a before/after of every changed line, then decide
```

Technical version:

```
Keyword score → pick environment + project → queue → lead agent's terminal
→ hive router → worker terminals → files change → git diff for review
```

---

## Step 1: You write the request

You type a sentence on the **Start** page, for example:

> Train a model to classify support emails

Nothing runs yet. The page re-reads your words after every keystroke, so the next step updates as you type.

---

## Step 2: Nexus picks the environment and project

**Office version:** the front desk reads your note and decides which department should take it: Software, Machine Learning, Data and so on.

### How the decision is made

Each environment has a list of clue words, and each clue is worth points.

| Environment | Some clue words (points) |
|---|---|
| Machine Learning | model (2), train (2), classif… (3), predict (3), dataset (2) |
| Software (SDE) | api (3), backend (3), website (3), bug (2) |
| Data Analytics | dashboard (4), sql (3), analy… (3) |

A word matches a clue if it **starts with** the clue, so "classify" matches `classif`.

For *"Train a model to classify support emails"*:

| Your word | Matches | Points |
|---|---|---|
| train | Machine Learning | +2 |
| model | Machine Learning | +2 |
| classify | Machine Learning | +3 |
| a, to, support, emails | nothing | 0 |
| **Total** | **Machine Learning** | **7** |

The environment with the most points wins. How sure Nexus is depends on the score:

| Score | Meaning | What happens |
|---|---|---|
| 4 or more | Strong match | Picked automatically |
| 1–3 | Weak match | Picked, but worth checking |
| 0 | No match | You choose |

7 is 4 or more, so this is a strong match for Machine Learning.

### Picking the project

Nexus selects the project folder you most recently used in that environment. You can pick another project, or choose a new folder, which becomes a new project when you press Start.

### Why a keyword score and not AI?

- **Instant:** no AI call, so it updates while you type.
- **Predictable:** the same sentence always gives the same answer.
- **Explainable:** the screen shows which words caused the choice, and if it's wrong you click a different environment.

**Code:** `src/renderer/src/nexus/start/startModel.ts` (`detectEnvironment`, `chosenEnvironment`, `startBlocker`).

---

## Step 3: The agents do the work

You press **Start with the lead agent**.

### 3a. A context label is attached

Your words are sent unchanged, with one header line naming the environment and project folder:

```
[Nexus context — workspace: ML · project: support-triage (C:\repos\support-triage) · page: Start]
Train a model to classify support emails
```

**Office version:** the front desk staples a label to your note so the team knows where to work.

**Code:** `src/renderer/src/nexus/assistant/` (`AssistantPort`, `leadAgentPort.ts`).

### 3b. The request waits in the queue

If the lead agent is busy, text typed into its terminal could get mixed into its current task. So the request waits in a **queue** until the agent is idle. The queue can also be paused, and it drops duplicate "compact your memory" commands.

**Office version:** the note waits in the team lead's in-tray.

**Code:** `enqueueMessage` in `src/renderer/src/store/store.ts`; delivery in `src/renderer/src/hooks/useHive.ts`.

### 3c. The lead agent receives it

The lead agent is a **real AI coding tool**, for example Claude Code, running in its own **terminal** (a PTY, or pseudo-terminal, which behaves exactly like a terminal you opened yourself). Nexus types your request into it.

The lead agent plans the work, adds tasks to the task board, and writes messages for helper agents into its **outbox**.

**Code:** terminals in `src/main/pty.ts`; supported tools listed in `src/shared/agentProvider.ts` (claude, codex, grok, qwen, opencode and others).

### 3d. The mailroom delivers messages (the hive)

The **hive** is a folder kept in git that holds the team list, the task board, a shared notice board, and every agent's inbox and outbox. Every **1.5 seconds**, Nexus's main process collects messages from each outbox and puts them in the right inbox.

Only Nexus's main process writes to the hive, and git keeps the history, so every coordination step can be looked back on.

**Office version:** the mail clerk's round, plus the office filing cabinet.

**Code:** `src/main/hive.ts`.

### 3e. The helpers do the work

Each helper, for example an "ML engineer" and a "Tester", is another AI coding tool in its own terminal. They read their inbox, edit files in **your project folder**, and run commands such as training the model or running tests.

### 3f. Status updates (hook events)

Every agent reports what it's doing (using a tool, finished, waiting for you) to Nexus over a local connection secured with a per-agent token. Those reports drive the status dots and the task board you see on the **Agents** screen.

**Office version:** employees phoning reception to say "I'm working" or "I'm done".

**Code:** `src/main/hooks.ts`.

---

## Step 4: You review the changes

The agents' work ends up as changed files in your project folder. The **Changes** screen runs `git diff` on that folder and shows exactly which lines changed:

- **green:** lines added
- **red:** lines removed

You see the actual code, not a summary or the AI's description of it, so you know exactly what you're approving.

**Office version:** a before/after copy of every document the team touched.

---

## Safety built in

- **The screen side can't touch your computer directly.** Every action goes through named, checked requests to Nexus's main process.
- **Only known AI tools can be started**; anything unknown needs your approval.
- **API keys stay inside Nexus;** agents get short-lived access tokens instead.
- **A cost and loop guard** steps in if an agent runs away: it steers, then restricts, then stops it.

---

## Glossary

| Term | Meaning |
|---|---|
| Environment / workspace | The kind of work: Software, Machine Learning, Data and so on |
| Lead agent | The AI that plans the work and hands it out |
| Worker agent | An AI that does part of the work |
| Terminal / PTY | The command window each AI coding tool runs in |
| Queue | Where your request waits until the lead agent is free |
| Hive | The shared, git-tracked folder for the team list, tasks and messages |
| Router | The part of Nexus that delivers hive messages every 1.5 seconds |
| Hook events | Status reports each agent sends back to Nexus |
| git diff | The before/after view of exactly which lines changed |
