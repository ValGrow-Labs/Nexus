---
name: nexus-sde-app-manifest
description: Draft the nexus.app.json manifest that tells Nexus how to run the built application and how to check that it is healthy, as part of a change set.
version: 1
---

# Draft the application manifest

Nexus starts a dev deployment of a built application only when the repository
has a `nexus.app.json` at its root. The manifest says how to run the app and
where its health check answers. Nexus validates it (the `app.manifest_schema`
check) and probes the health path on 127.0.0.1 before calling the app healthy.

## What the manifest holds

- How to run the app: an argument list (never one shell string), run from the
  built output.
- The port the app listens on inside its container.
- A health path that answers HTTP 200 when the app is ready, for example
  `/health`.
- The names (never the values) of environment variables the app reads.

Read the schema Nexus reports when a manifest is refused, and match it exactly.
Keep the file under 16 KiB.

## Steps

1. Call `context_get`, then read the project: its package.json scripts or
   Python entry point, its build output folder, and the port and routes the
   server code uses.
2. If the app has no health route, add a minimal one that returns 200 without
   touching a database or the network, with a test for it (see
   `nexus-sde-tests-first`).
3. Write `nexus.app.json` at the repository root with the run argv, the port,
   the health path and the environment variable names.
4. Run the build and the tests with `sandbox_exec`. Start the app once inside
   the container and request the health path with a short timeout to see it
   answer.
5. Register the change with `changeset_register` (follow `nexus-sde-change`).

## Rules

- The app must listen on the port in the manifest, on all container
  interfaces; Nexus publishes it on 127.0.0.1 only.
- Never put a secret, a token or a password in the manifest or in an
  environment variable default.
- The app runs without network access to the outside; do not depend on a
  remote service to answer the health check.

## When the person asks for an app, a website or a web page

Nexus shows the running app beside the chat, so a request for an app is a request for something that RUNS. Make it runnable:

- Prefer Node's standard library. If the app really needs packages, list a few well-known ones in `package.json` (`dependencies`, and `devDependencies` for a build tool). Your sandbox has no internet, so you cannot install or run them yourself: Nexus asks the person once and downloads them from the package website when they press Preview (install scripts are off, so choose packages that need no install script; a package with a native part will not work), then builds and runs with them. Keep the list short, and write the code carefully. No CDN, no remote fonts or scripts, no database server.
- `package.json` with `scripts.build` (writes the finished files to `dist`) and `scripts.start`.
- `src/server.js` listens on port 3000 on `0.0.0.0`, serves the files in `dist` and answers `GET /health` with 200.
- `nexus.app.json` with `run: ["node", "src/server.js"]`, `port: 3000`, `healthPath: "/health"`, `env: []` and `build: { outputDir: "dist" }`.
- Run the build in the sandbox, then check the server answers `/health` with a command that ends by itself, before you register the change. If the build or the server needs packages you cannot install, say so in your hand-off instead.
