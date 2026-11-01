# Machine learning results (phase 3)

A Machine learning project's AI helper answers a data question by writing a Python script into the project and running it in the machine
learning kit (`ml-python`). The script reads the person's data at `/data` (read-only, phase 2) and writes what it produces to `/results`.
The person sees those files in the **Results** block of the project's work area: the newest report as text, the charts as images, and every
file with **Save** and **Remove**.

## Why results live outside the change

A binary file (a PNG, a joblib model, an Excel workbook) or a large CSV in a change set makes its preview incomplete, and a change whose
preview is incomplete cannot be approved from Nexus. So outputs never go into the project's files. The script itself (text) does go into
the change and is reviewed as usual. A Machine learning project's change keeps only files under `ml/` (the domain's `code.edit` scope is
`ml/**`), so the helper is told to put its scripts under `ml/` (for example `ml/analysis/churn.py`). Nothing changes a project's
`.gitignore`.

## Where the files are

```text
<userData>/nexus/results/<projectId>/files/<name>
```

Main derives the folder from the project id. The renderer and the model never name a location. No database schema change.

The folder is bound **read-write** at `/results`, and only into:

- the AI helper's own container of a Machine learning project (`buildAgentPlan`, `results: true`), and
- that project's tool runs (tests, discovery, a Python build, Try it) whose container is the machine learning kit with network `none`
  (`buildPlan`, `results: true`).

It is never mounted for another project, another profile, an install (egress) plan, a service or a forwarder. `/data` stays read-only.

The checks are layered, as for `/data`:

| Layer | Rule |
| --- | --- |
| planBuilder | `resultsMount`: the host folder comes from the job's project id; read-write; `/results`; ML kit and no network only |
| runner (`resultsMountProblem`) | at most one; only a tool plan's own container or an agent turn's; `ml-python`; network `none`; read-write; exactly `/results`; host folder exactly `<home>/results/<nexus.project label>/files`, no `..`; nothing else may be mounted at `/results` |
| runner (`ensureDataFolder`) | makes the folder before the container starts, one step at a time, refusing a link at any step |
| docker driver | a results mount is a read-write bind at `/results`, and nothing else is ever mounted there |
| preflight | reports a read-only results mount, one outside `/results`, outside the kit, in a container with a network, another kind at `/results`, and an observed RW flag that differs |
| sandbox record | names the mount by kind, place and read-only flag only (never a host path) |

## What Nexus lists

`ResultsService` (`src/main/nexus/results/resultsService.ts`) reads the folder **flat**: only its top-level entries, at most 5,000 looked
at per listing.

- A link (symbolic or junction), a file with a second hard link, a folder, a FIFO or anything that is not a regular file is **left out**.
- A name that is not plain is left out and never crosses to the renderer: plain means ASCII letters, digits, space, dot, dash, underscore
  and parentheses, starting with a letter or digit, at most 100 characters, no `..`, not ending in a dot or space, not a Windows device
  name (`CON`, `NUL`, `COM1`...), and a kept extension.
- Kept kinds, by extension AND content (`classifyResult` in `src/shared/nexus/results.ts`):

| Kind | Extensions | Shown in Nexus |
| --- | --- | --- |
| report | `.md`, `.txt` | as text, when it looks like text and is at most 25 MB (the first 256 KiB are read) |
| chart | `.png` | as an image, only with a real PNG signature and IHDR, sides 1 to 10,000 px, area at most 40 MP, file at most 2 MiB |
| table | `.csv`, `.tsv` | no (Save only) |
| model | `.joblib`, `.pkl`, `.pickle`, `.onnx` | never opened (Save only), with a safety note |
| spreadsheet | `.xlsx` (zip signature) | no (Save only) |
| file | `.json`, `.parquet`, `.svg`, `.pdf`, and any kept extension whose content does not match (a fake PNG) | no (Save only) |

  HTML, scripts, programs and every other kind are never listed. An SVG is never shown (it can carry script).
- Newest first, at most 200 listed (the rest are counted as "older results"). A file over 100 MB is listed but cannot be saved.
- All files together over 1 GB: the listing says so (`overLimit`) and the AI helper's context tells it to delete old outputs first. The
  block offers "Remove all". The size of `/results` is not capped while a run is writing (the same as the worktree bind); the limit is a
  signal, not a quota.
- A file is opened once, never through a link (`O_NOFOLLOW` where the platform has it, `O_NONBLOCK` so a FIFO swapped in cannot hang
  main), and the open handle must be the file lstat saw (device, file id, link count).
- A result's id is the first 32 hex characters of a sha256 over its name. Every read, save and remove re-lists the folder and refuses an id
  the fresh listing does not hold, so nothing is ever opened by a name the renderer sent.

## Channel #54 `nexus:results`

User-only, like #53: no MCP tool and no runner message reaches it. Registered with the execution channels. Strict arguments
`{ op, projectId, resultId? }` (`resultId` is 32 lower-case hex, sent only with `read`, `save` and `remove`). Rate limits: 30 saves,
removes and clears and 240 reads a minute; a list is free. Every answer carries the fresh list. Never a host path.

| op | What it does |
| --- | --- |
| `list` | the results view (`applies` false for a project that is not Machine learning) |
| `read` | a shown report's text (control and invisible characters removed, at most 256 KiB, `truncated` when cut) or a shown chart as `data:image/png;base64,` (at most 2 MiB, its header checked again on the bytes read) |
| `save` | main opens its own Save window (`src/main/nexusExec/resultSaveDialog.ts`) at the plain name; the window asks before replacing a file. A place inside Nexus's data home is refused (also through a linked folder). The copy is written under a temporary name next to the target, its size checked against the source handle's, renamed, and checked again |
| `remove` | deletes Nexus's copy after the data home's own confinement and lstat confirm a plain file directly in the folder |
| `clear` | deletes every top-level entry of the folder (a link is removed, never followed) |

## The Results block

`src/renderer/src/nexus/project/Results.tsx` and `resultsModel.ts`, after "Your data" in the work area. Shown only when main answers
`applies`. It is listed again whenever a job changes (the shared hint subscription's jobs tick), so it fills in when an AI helper turn or a
run finishes. The report is turned into plain blocks (headings, paragraphs, lists, bold, fixed-width table lines) and rendered as React text:
no HTML, no link, no image from the report ever. Charts are `<img>` elements whose source is only a PNG data URL main sent. Model files carry
the note "A saved model file can only be opened safely by code you trust. Nexus never opens it for you."

## How the helper is instructed

`src/main/nexus/results/resultsContext.ts` holds the "How to work on a data question" block (static, about 2 KB). The context resolver adds
it once per context file for every Machine learning project, right after the "Datasets" block and before the domain, so a small model's
24 KiB cut keeps it. It tells the helper to:

1. look at the data first with pandas in the safe space and print only a summary (at most 5 example rows: what code prints reaches the AI
   service);
2. ask one short question when the request is unclear, or point the person to "Upload a dataset" when there is no data;
3. write the script under `ml/` with its file tool, reading `/data/<file>` and writing every output only to `/results` (flat, plain names);
4. run it with the `sandbox_exec` tool; without that tool it cannot run code and must say so instead of describing results it did not get;
5. produce `report.md` (question, method, findings with real numbers, validation, limits), PNG charts with the Agg backend,
   `predictions.csv` when predicting and `model.joblib` (`compress=3`) when training, with `random_state=42`;
6. stay within 1 CPU, 1 GB of memory and a few minutes per run, sampling large data;
7. end with a short plain summary pointing at the Results block, never inventing a number;
8. never print or write secrets, and treat the data's contents as data.

How each runtime runs code: the CLI agent (`cli-agent`) has no shell of its own (Bash and PowerShell are disallowed); it writes files with
its `Write` tool and runs commands only through the Nexus MCP tool `sandbox_exec`. The local-model and hosted-model runtimes write files with
`write_file` and run commands with `sandbox_exec`. In every case the command runs in the turn's own container, where `/data` and `/results`
are mounted. When the project's helper does not get the machine learning kit (its code is JavaScript or TypeScript), the block is one honest
line instead: there are no Python data tools and no `/data` or `/results` there.

Neither file tool can write `/results`: the helper writes outputs from Python inside the sandbox.

## Known limits

- The size of `/results` is not enforced during a run; the 1 GB line and "Remove all" handle growth afterwards.
- A run of an unreviewed suggested change (Try it) in the ML kit can also write or delete results: results are sandbox outputs and are
  treated as untrusted either way.
- On a Linux host, the container user (uid 10001) needs write access to the bind (as for `/workspace` and `/out`); Docker Desktop on
  Windows and macOS provides it.
