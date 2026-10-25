---
name: nexus-sde-change
description: How to make one change to a repository inside a Nexus agent turn - read, edit within the worktree, run commands in the turn's container, then register the change set for the user's review.
version: 1
---

# Make a change in the session worktree

This turn works on one change to the project's repository. Nexus has checked out
the latest accepted code into a session worktree. Edit files there, prove the
change with tests, and register it. The user reviews, accepts and merges; this
turn never does.

## Where things are

- **Files.** The file tools (read, edit, write, find and search files) work
  inside the session worktree only. Use paths relative to the worktree root. Never use an
  absolute path, `..`, a link or a junction to leave it.
- **Commands.** There is no shell on the host. Run every command with the
  `sandbox_exec` tool. It runs in this turn's own container, with the worktree
  mounted at `/workspace` and **no network access**. Pass `argv` as a list of
  words (never one shell string), an optional `cwd` under `/workspace`, and a
  `timeoutMs` that fits the time the turn has left.
- **Context.** Call `context_get` first: it names the requirement, the focus
  versions, earlier messages, review comments and diagnostic facts this turn
  was given. Use `artifact_list`, `artifact_read` and `validations_get` to read
  more; you can read the turn's inputs and your own outputs only.

## Steps

1. Read the context and the relevant code. Restate the goal and the acceptance
   criteria you are working to in one short paragraph.
2. Find how the project runs its tests (package.json scripts, pytest settings).
   Run the existing tests once with `sandbox_exec` to know the starting point.
3. Make the smallest change that meets the criteria. Keep the existing style.
   Follow the `nexus-sde-tests-first` skill when the change adds behaviour.
4. Run the tests again with `sandbox_exec` until they pass. Command output is
   for you only: it is not evidence. Nexus runs its own tests on the change.
5. Register the change with `changeset_register`, giving a short `message` that
   says what changed and why, and a `clientKey` you reuse if you retry.
6. If a check fails after registration, read the result with
   `validations_get`, fix the cause, and register again.
7. Call `review_request` with the version id and a one-line note when the
   change is ready for the user.

## Dependencies

The container has no network. When the project's dependencies are missing, ask
for an install with `job_request`, the recipe `sde.deps.node` or
`sde.deps.python` (the one that matches the repository) and `inputs` holding
exactly one repository version id, taken from the versions you were given. The
same rule applies to `sde.test.discover`. A request without that input, or
naming any other version, is refused. The user approves the download first;
wait for it. Never try to download anything from inside `sandbox_exec`.

## Rules

- Stay inside the path scope. Never create, read or change `.git`, `.env*`,
  `*.pem`, `*.key`, `id_rsa*`, `.npmrc` or `.pypirc`; the change set is refused
  if it touches them.
- Never write a secret, a key, a token or a password into a file, a commit
  message, a note or a command. A change set holding a provider key or a private
  key is refused.
- Do not commit, push, merge or change branches yourself. Nexus commits the
  worktree when you register, on its own ref, and the user decides the rest.
- Do not claim success because a command exited 0 or a file exists. Say what the
  tests showed, and let Nexus's checks decide.
- If the goal cannot be met, say so plainly, say why, and register nothing.
