# B2b user decisions (2026-10-21), binding

Phase-by-phase: plan → build → verify → report → STOP. Execution stays off by default until B2b is verified.

- D-B1/D-B3: Claude CLI runs on the host under the runner using the user's existing login store in place (no CLAUDE_CONFIG_DIR override); Nexus never reads, copies or stores the credential. Every command goes into a network-none container via sandbox.exec. The file-tool boundary is policy, not OS isolation; UI and docs say so. If the real-login smoke fails under the isolation flags, STOP and ask about a setup-token (do not fall back silently).
- D-B2: one network destination, api.anthropic.com:443, for the agent process only, via the runner-hosted proxy, granted once in the setup sheet and revocable. Anything else the CLI needs → STOP and ask.
- D-B4: caps $2/turn, $10/day, 6 turns/hour, 1 concurrent turn, 400k tokens/turn, 200 tool calls, 30 min wall clock, 20 child jobs; cost labelled "reported" (estimate).
- D-B6/A3: writes into the user's .git allowed with a once-per-project approval; worktrees under <userData>\nexus\wt\, refs only under nexus/*; accept never touches the user's checked-out branch or files; "Merge accepted work" is a dialog-confirmed fast-forward that refuses a dirty tree or non-fast-forward.
- D-B5, D-B7, D-B8, D-B9, D-B10: plan recommendations accepted by the controller (2.1.x with pinned-flag check; context rebuilt each turn; commit identity "Nexus agent <agent@nexus.invalid>" + Nexus-Job trailer; engine name only on the setup row; channel #51 nexus:agent:consent).
- D-B11: v10 migration runs on a test copy, then a fingerprinted backup, then the real DB, ONLY with the user's go-ahead at verification; test:exec needs ≥ 30 GiB free (currently ~21 GB) and Docker running.
- D-B12 (2026-10-21): YES — implementing agents may run the installed CLI only inside the harness (fake home, fake key, loopback mock model, deny-all proxy); never the user's home, login, CLI store or the network. Real-login checks stay controller-only with the user's go-ahead.
- D-B13: hidden refs under refs/nexus/* (refs/nexus/job/*, refs/nexus/accepted/<branch>).
- D-B14: provider keys and private-key headers block a change set; high-entropy strings are advisory only; lockfiles excluded.
- D-B15 (2026-10-21, after Task 0 STOP S2): DROP `--safe-mode` (it removes the Nexus MCP server). Keep `--restricted`, `--setting-sources ""`, `--strict-mcp-config`, `--permission-mode` + `--allowedTools` + `--disallowedTools` (list `Task` AND `Agent`, `PowerShell`, `Bash`, `WebFetch`, `WebSearch`, `NotebookEdit`). Add a test (CR3+) proving the user's CLAUDE.md, hooks, plugins and other MCP servers never load. The CLI's MCP log under the user's LOCALAPPDATA must be covered by CR10/V3.
