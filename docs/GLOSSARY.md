# Nexus glossary: the words people read

Nexus is for new, often non-technical people. Everything on screen uses **one plain name per idea**. The names live in one place,
[`src/renderer/src/nexus/data/glossary.ts`](../src/renderer/src/nexus/data/glossary.ts) (`GLOSSARY`, with `termName` and `termHelp`).
This table is generated from that file: change the code first, then this page. Code, routes, ids, IPC channels, database values and
reason codes keep their technical names; only what a person reads uses these words.

| Say this | What it means (the one line of help) | Id in the code |
|---|---|---|
| suggested changes (one: suggested change) | Edits the AI helper suggests. Nothing changes in your files until you say so. | `suggestedChanges` |
| AI helper | The AI that builds things for you. It works in a safe copy and never in your real files. | `aiHelper` |
| lead AI helper | The AI helper that takes your requests and passes the work on to others. | `leadHelper` |
| AI service | The service that does the thinking for the AI helper. | `aiService` |
| Free online AI | An AI service on the internet that you can use for free with a key you create yourself. | `freeOnlineAi` |
| AI on this computer | An AI that runs on your own computer. It is free and private, but it can be slow. | `aiOnThisComputer` |
| Your own plan | An AI service you already pay for, such as a subscription you signed up for. | `yourOwnPlan` |
| access key | A secret code that lets Nexus use an AI service for you. Keep it private. | `accessKey` |
| internet permission | You choose which online address the AI helper may talk to. You can take it back at any time. | `internetPermission` |
| Allow once | Nexus asks before it does something with a side effect. This allows just this one time. | `allowOnce` |
| safe copy of your project | A separate copy where the AI helper works, so your real files stay untouched. | `safeCopy` |
| starting point | Nexus remembers how your project looks right now, so it can compare later. | `startingPoint` |
| hidden Nexus notes | A small hidden area where Nexus keeps its own notes. Your files and your main version are never changed. | `hiddenNotes` |
| your project's main version | The line of saved work you normally use. | `mainVersion` |
| Nexus's saved copy | Where Nexus keeps the changes you kept, until you add them to your project. | `nexusCopy` |
| Looks good | Say that you read the suggested changes and they are fine. | `looksGood` |
| Keep these changes | Save the suggested changes in Nexus's copy. Your own files are not touched yet. | `keepChanges` |
| Add to my project | Copy the kept changes into your project's main version. You confirm in a separate window first. | `addToProject` |
| saved version | A saved point in your project's history. | `savedVersion` |
| what changed | The lines that were added and removed. | `whatChanged` |
| task | One piece of work Nexus runs for you, like building or testing. | `task` |
| request | One message you sent and the work the AI helper did for it. | `request` |
| conversation | A back-and-forth with the AI helper. | `conversation` |
| safe space | A closed box on your computer where code can run without touching anything else. | `safeSpace` |
| Docker | A free program that makes safe spaces. Install Docker Desktop so Nexus can run code safely. | `docker` |
| Get this computer ready | Checks the things Nexus needs on this computer. | `getReady` |
| check | Nexus asks the app a simple question to see if it is working. | `check` |
| test run of your app | Starts your app on this computer only, so you can try it. | `testRun` |
| saved item | Anything your projects produce: notes, builds, suggested changes. | `savedItem` |
| made from | What this item came from, and what uses it. | `madeFrom` |
| workspace | A set of tools for one kind of work, like building software or analysing data. | `workspace` |
| handoff | Pass a finished item to another workspace in the same project. | `handoff` |
| required check | A check that must pass before you can go on. | `requiredCheck` |
| checks | Automatic tests Nexus runs on a version. | `autoChecks` |

Workspaces are spelled out for people: `sde` = Software, `ml` = Machine learning, `dl` = Deep learning, `qa` = Testing. The short codes stay in code and routes.

## Words we replaced

| Do not say | Say |
|---|---|
| change set | suggested changes |
| agent, runtime, engine | AI helper, run by an AI service (Free online AI, AI on this computer, Your own plan) |
| consent | internet permission |
| worktree | safe copy of your project |
| repository snapshot | starting point |
| hidden refs | hidden Nexus notes |
| Approve, Accept, Merge | "Looks good", "Keep these changes", "Add to my project" |
| sandbox | safe space |
| artifact | saved item |
| job | task |
| turn, session | request, conversation |
| API key | access key |
| Execution setup | Get this computer ready |
| dev deployment | test run of your app |
| build phase codes (B2b, B2c ...) | coming later (never show a phase code) |

## Writing rules

1. Use short sentences, about a 12-year-old reading level, and short words.
2. Never show an id, a reason code, a check name, a phase code or a git word. Say what it means instead.
3. Say what a button will do, and say what to do next.
4. Use one name for one idea, from the table above. Do not invent a second name.
5. Never say more than is proven: keep every "not verified" and every honest limit, and never claim that work is complete when it is not.
6. Main's fixed sentences (`src/main/nexusIpc/envelope.ts`) and the renderer's copy (`src/renderer/src/nexus/data/errorCopy.ts`) are the same word for word, so change both together, and update the docs that quote them (`docs/nexus/platform-core.md`, `docs/SHOWCASE.md`).
