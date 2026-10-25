// Shared execution contracts (B2a): the sandbox a job runs in, the plan main
// hands to the runner, and the facts the runner reports back. Types and a few
// constant tables only; no I/O. Main builds every value of these types; the
// renderer never supplies a path, a command, a network or a limit.

import type { RunRequest, RuntimeKind } from './runtime';

/** The sandbox profiles. Each maps to one pinned image. */
export type SandboxProfileId = 'sde-node' | 'sde-python' | 'qa-web' | 'data-python' | 'ml-python' | 'dl-cpu' | 'nexus-fwd';
export const SANDBOX_PROFILE_IDS: readonly SandboxProfileId[] =
  ['sde-node', 'sde-python', 'qa-web', 'data-python', 'ml-python', 'dl-cpu', 'nexus-fwd'];

/** Every container runs as this non-root user (`--user`). */
export const SANDBOX_UID = 10001;
export const SANDBOX_GID = 10001;
export const SANDBOX_USER = `${SANDBOX_UID}:${SANDBOX_GID}`;
/** The two tmpfs mounts every container gets; `/tmp` is sized by `ResourceLimits.tmpfsMb`. */
export const TMP_TMPFS_PATH = '/tmp';
export const HOME_TMPFS_PATH = '/home/nexus';
export const HOME_TMPFS_MB = 256;

export interface SandboxProfile {
  id: SandboxProfileId;
  /**
   * `repository` and `digest` name the pinned base (recorded per attempt). `source`: `built` (default; every B2a
   * profile: Nexus builds the image locally, so containers are created by the local image id `sha256:<id>`) or
   * `pulled` (an image pulled from a registry by digest: containers are created by `repository@digest`).
   */
  image: { repository: string; digest: `sha256:${string}`; source?: 'built' | 'pulled' };
  user: { uid: 10001; gid: 10001 };                              // non-root
  defaults: ResourceLimits;
  /** The Nexus-owned entry (`nexus-entry <wallSeconds> … --`); the recipe argv follows it as `Cmd`. */
  entrypoint: string[];
  /** ENV names the image itself sets (PATH, HOME, LANG, NODE_VERSION, …). Any other name in a container is refused. */
  imageEnv: string[];
}

export interface ResourceLimits {
  cpus: number;            // --cpus
  memoryMb: number;        // --memory and --memory-swap (no swap)
  pids: number;            // --pids-limit
  wallClockMs: number;     // runner timer + the entry script's own timeout
  outputMaxBytes: number;  // the /out size guard
  tmpfsMb: number;         // size of the /tmp tmpfs
}

export type NetworkMode =
  | { mode: 'none' }
  // An approved install: the INTERNAL network nexus-egress-in-<jobId> only (no route out); it reaches the allow-listed
  // registries through the job's Nexus egress proxy (src/shared/nexus/egressPolicy.ts).
  | { mode: 'egress-approved'; approvalId: string; purpose: 'deps' | 'weights' }
  // The egress proxy of that install: nexus-egress-in-<jobId> (alias nexus-egress-proxy) AND the outbound bridge nexus-egress-out-<jobId>.
  | { mode: 'egress-proxy'; approvalId: string }
  | { mode: 'service-internal'; network: string }                                // internal nexus-svc-<jobId>
  | { mode: 'test-internal'; network: string };                                  // joins a preview's internal network

export interface MountSpec {
  /** `worktree` (B2b): an agent turn's session worktree, bind-mounted read-write at `/workspace`. */
  kind: 'input' | 'workspace' | 'out' | 'deps' | 'log' | 'worktree';
  /** An absolute host path (a bind mount) or a named volume (`nexus-ws-<attemptId>`, `nexus-deps-…`). */
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
  versionId?: string;
  contentHash?: string;
}

export interface ContainerLabels {
  'nexus.job': string; 'nexus.attempt': string; 'nexus.boot': string; 'nexus.project': string;
  /** What the container is for (`tool`, `service`, `forwarder`); main sets it on every container it plans. */
  'nexus.kind'?: string;
  /**
   * This install: the first 16 hex characters of the sha256 of the resolved data-home root. Restart recovery removes
   * only resources that carry this install's value (another Nexus on the same Docker daemon is never touched).
   */
  'nexus.home'?: string;
}

/**
 * The labels the runner puts on every volume and network it creates for an attempt (`nexus-ws-*`, `nexus-egress-*`,
 * `nexus-svc-*`, `nexus-pub-*`), exactly as given: restart recovery scopes its removals by `nexus.home` and `nexus.attempt`.
 */
export interface ResourceLabels {
  'nexus.job': string; 'nexus.attempt': string; 'nexus.boot': string; 'nexus.project': string; 'nexus.home': string;
}

export interface ContainerSpec {
  name: `nexus-${string}`;
  labels: ContainerLabels;
  profile: SandboxProfileId;
  /**
   * The image to run, digest-pinned: `ref` is `<repository>@sha256:<64 hex>` or the local image id itself
   * (`sha256:<64 hex>`, for an image Nexus built); `id` is the local image id. Main fills it from the
   * profile and the latest succeeded image build.
   */
  image: { ref: string; id: `sha256:${string}` };
  entrypoint: string[];                 // the profile's entry, exactly (Config.Entrypoint)
  argv: string[];                       // filled from the recipe template; never a shell string (Config.Cmd)
  imageEnv: string[];                   // copied from the profile: ENV names the image may set
  env: Record<string, string>;          // non-secret, recipe-declared, validated
  mounts: MountSpec[];
  network: NetworkMode;
  limits: ResourceLimits;
  readOnlyRootfs: true;
  capDrop: ['ALL'];
  noNewPrivileges: true;
  /** An app container's port and health path; reachable only through the forwarder. */
  service?: { containerPort: number; healthPath: string };
  /** The forwarder only: the single loopback port it publishes. */
  publish?: { hostIp: '127.0.0.1'; hostPort: number; containerPort: number };
}

export interface PreflightObserved {
  nanoCpus: number; memory: number; memorySwap: number; pidsLimit: number; networkMode: string; readonlyRootfs: boolean;
  capDrop: string[]; capAdd: string[]; privileged: boolean; user: string; securityOpt: string[];
  mounts: { dst: string; rw: boolean; type: string }[]; portBindings: string[]; tmpfs: string[]; devices: string[];
}

/** The result of comparing `docker inspect` with the spec. Any problem: remove the container, fail `limits_not_applied`. */
export interface PreflightReport {
  ok: boolean;
  observed: PreflightObserved;
  problems: string[];
}

export interface ExitInfo { code: number | null; signal?: string; oomKilled: boolean; finishedAt: number }

export interface SandboxProbe {
  docker: 'missing' | 'stopped' | 'running';
  version?: string; os?: string; wsl2?: boolean;
  cpus?: number; memoryBytes?: number;
  gpu: { detected: boolean; model?: string; usableInContainers: false };
}

export interface ImageStatus {
  profile: SandboxProfileId;
  present: boolean;
  digestMatches: boolean;
  sizeBytes?: number;
  imageId?: string;
  contextSha256?: string;
  /**
   * The image's `nexus.versions` label (B2a Task 12): the tool versions its build self-test checked, e.g.
   * `python=3.11.13 pytest=8.4.2`. Recorded in every attempt's environment (constraint 8).
   */
  versions?: string;
}

/** The `nexus.versions` label as it may travel: plain `name=version` words, at most 300 characters. */
export const IMAGE_VERSIONS_RE = /^[A-Za-z0-9][A-Za-z0-9._+=-]*(?: [A-Za-z0-9][A-Za-z0-9._+=-]*){0,15}$/;

export interface SandboxDriver {
  probe(): Promise<SandboxProbe>;
  imageStatus(profile: SandboxProfileId): Promise<{ present: boolean; digestMatches: boolean; sizeBytes?: number }>;
  prepareImage(profile: SandboxProfileId, approvalId: string, signal: AbortSignal): AsyncIterable<{ phase: string; bytes?: number }>;
  create(spec: ContainerSpec): Promise<{ containerId: string }>;
  preflight(containerId: string, spec: ContainerSpec): Promise<PreflightReport>;
  start(containerId: string): Promise<void>;
  exec(containerId: string, argv: string[], o: { timeoutMs: number; signal: AbortSignal; maxOutputBytes: number }):
    Promise<{ exit: ExitInfo; stdout: string; stderr: string; truncated: boolean }>;
  wait(containerId: string, signal: AbortSignal): Promise<ExitInfo>;
  inspect(containerId: string): Promise<{ state: 'created' | 'running' | 'exited' | 'missing'; exit?: ExitInfo; restartCount: number }>;
  stop(containerId: string, graceMs: number): Promise<void>;
  remove(containerId: string): Promise<void>;
  listByLabels(labels: Partial<ContainerLabels>): Promise<{ containerId: string; labels: Record<string, string>; state: string }[]>;
}

/** One file the runner hashed out of `/out` into the object store (already under `objects/`). */
export interface StagedOutput { relPath: string; sha256: string; bytes: number; mediaType: string }

export type ParserId =
  | 'junit' | 'discovery' | 'app-manifest' | 'repo-snapshot' | 'diagnostic'
  | 'cobertura' | 'metrics-json' | 'metrics-jsonl' | 'stats-json' | 'duckdb-summary' | 'papermill'
  /** B2b: the facts of a git write engine (src/runner/gitWrite.ts), re-validated by main before anything is recorded. */
  | 'git-facts';
export const PARSER_IDS: readonly ParserId[] = ['junit', 'discovery', 'app-manifest', 'repo-snapshot', 'diagnostic',
  'cobertura', 'metrics-json', 'metrics-jsonl', 'stats-json', 'duckdb-summary', 'papermill', 'git-facts'];

/** A parser's normalized result. `normalized` is schema-checked again by main before it becomes evidence. */
export interface ParsedOutput { parser: ParserId; sourceSha256: string; normalized: unknown }

/**
 * Why the runner refused the contents of `/out` (no output from that attempt is trusted). `secret_in_report`: a parser
 * result held a secret-shaped value, so the runner withheld it (no secret leaves the runner in a message).
 * `unreadable_output_entry` (B2a final review B4): an entry of `/out` could not be read (EACCES, EPERM, ...): the outputs
 * are refused like any other bad entry, never reported as a lost runner.
 */
export type OutputErrorCode =
  | 'symlink' | 'hardlink' | 'special_file' | 'bad_name' | 'file_locked' | 'too_many_files'
  | 'output_too_large' | 'workspace_too_large' | 'secret_in_report' | 'unreadable_output_entry';
export const OUTPUT_ERROR_CODES: readonly OutputErrorCode[] = ['symlink', 'hardlink', 'special_file', 'bad_name', 'file_locked',
  'too_many_files', 'output_too_large', 'workspace_too_large', 'secret_in_report', 'unreadable_output_entry'];

// ----- attempt plans (main → runner); every path in a plan is main-owned, under the data home -----

interface PlanBase {
  attemptId: string;
  jobId: string;
  attemptN: number;
  recipe: { id: string; version: string };
  workDir: string;        // <dataHome>/work/<jobId>/<n>, with in/ and out/
  logPath: string;        // <dataHome>/logs/jobs/<jobId>/<n>.log
}

/** A recipe that runs to completion in one container. */
export interface ToolPlan extends PlanBase {
  kind: 'tool';
  container: ContainerSpec;
  /** What the runner stages into `in/` before create: a git archive of one commit, and blobs copied with a re-hash. */
  staging: {
    source?: { repoPath: string; commit: string };
    blobs: { sha256: string; relPath: string }[];
    depsVolume?: { name: string; readOnly: boolean };
  };
  /** The labels of every volume and network the runner creates for this attempt (with `nexus.home`). */
  resourceLabels: ResourceLabels;
  /** Files under `/out` that must exist for the attempt to count as having produced its outputs. */
  outputContract: { required: string[]; maxFiles: number };
  parse: { parser: ParserId; relPath: string }[];
  /**
   * Egress plans only: the approval main consumed for THIS attempt (its id, and the job and attempt number that consumed
   * it). The runner refuses an `egress-approved` network whose `approvalId` is absent or differs from it, or whose
   * consumer is another job or attempt (defense in depth; main's plan builder already refuses).
   */
  approval?: { id: string; jobId: string; attemptN: number };
  /**
   * Egress plans only (B2a stabilization, constraint 5): the job's Nexus egress proxy. The install container (`container`)
   * is on `networks.internal` only; the proxy joins it (alias `nexus-egress-proxy`) and `networks.outbound`, and allows
   * HTTPS CONNECT to the recipe's allow-list only (NEXUS_EGRESS_ALLOW). Both containers pass preflight before either starts.
   */
  egressProxy?: { container: ContainerSpec; networks: { internal: string; outbound: string } };
  /**
   * node:test runs only (B2a Task 12, A5): node's JUnit reporter names no file, so the Nexus entry runs each discovered
   * file on its own (`nexus-node-test`), writing `/out/<dir>/<NNNN>.xml` for `files[NNNN - 1]`. After the exit the
   * runner (Nexus's normalization) merges them into `/out/junit.xml` with every case attributed to its file, from this
   * main-derived mapping, never from anything the container wrote.
   */
  perFileJunit?: { dir: 'junit'; files: string[] };
}

/** A long-lived app container behind a loopback forwarder (dev deployment). */
export interface ServicePlan extends PlanBase {
  kind: 'service';
  deploymentId: string;
  app: ContainerSpec;
  forwarder: ContainerSpec;
  networks: { internal: string; publish: string };
  /** The labels of every volume and network the runner creates for this attempt (with `nexus.home`). */
  resourceLabels: ResourceLabels;
  health: { path: string; startTimeoutMs: number; intervalMs: number };
  idleTtlMs: number;
  staging: ToolPlan['staging'];
}

/**
 * One byte range of an attempt log a diagnosis reads (B2a Task 12): `logPath` is that attempt's log under the data home
 * (`logs/jobs/<jobId>/<n>.log`, the runner re-derives and checks it), `offset`/`length` the range (clamped to the file);
 * `tail`: the last `length` bytes instead (main's row of a live attempt does not know the log's current size).
 */
export interface DiagnoseLogRange { attemptId: string; logPath: string; offset: number; length: number; tail: boolean }

/**
 * Work the runner does itself, without a container (async git, `docker inspect`). The B2b git writes run as system
 * child jobs; every ref they write is under `refs/nexus/*` (D-B13), and none touches the user's branch, index or files
 * except `repo.ff`, the dialog-confirmed fast-forward of "Merge accepted work".
 */
export type EngineTask =
  | { engine: 'repo.snapshot'; repoPath: string }
  | { engine: 'sde.app.assemble'; repoPath: string; commit: string }
  | { engine: 'sde.diagnose'; target: 'deployment' | 'job'; containerIds: string[]; logRanges: DiagnoseLogRange[] }
  /**
   * Initialises `integrationRef` at the branch head when it is absent (a compare-and-swap on absence), creates `ref` at
   * the integration head, then runs `worktree add --detach` and `worktree lock`.
   */
  | { engine: 'repo.worktree'; repoPath: string; worktreePath: string; ref: string; integrationRef: string; branch: string }
  /** Commits the worktree's changes within `scope` on `ref` (sizes capped); refuses links, nested repositories and gitlinks. */
  | { engine: 'changeset.collect'; repoPath: string; worktreePath: string; gitDir: string; ref: string; integrationRef: string;
      scope: string[]; message: string; maxFileBytes: number; maxTotalBytes: number }
  /** `merge-tree --write-tree` of `head` onto the integration head: whether it applies cleanly. Writes no ref. */
  | { engine: 'changeset.merge_check'; repoPath: string; integrationRef: string; head: string }
  /**
   * Merges `head` into the integration ref with a compare-and-swap `update-ref` from `expectedOld`. Before the
   * `update-ref` it reports a durable `accept.prepared { old, new }` progress event.
   */
  | { engine: 'changeset.accept'; repoPath: string; integrationRef: string; expectedOld: string; head: string; message: string }
  /** Moves the integration ref back from `from` to `to` (compare-and-swap): an accept whose database part failed. */
  | { engine: 'changeset.accept_rollback'; repoPath: string; integrationRef: string; from: string; to: string }
  /** `merge --ff-only <sha>` on the user's checked-out `branch`; refuses a dirty tree or a non-fast-forward. */
  | { engine: 'repo.ff'; repoPath: string; branch: string; sha: string };

/** The most bytes of each side a diff read returns (1 MiB). */
export const GIT_DIFF_MAX_BYTES_PER_SIDE = 1_048_576;

/** A bounded git read (B2b): it writes nothing and runs as no job (the runner answers `git.read.result`). */
export type GitReadTask =
  | { read: 'status'; repoPath: string; branch: string; integrationRef: string }
  | { read: 'diff'; repoPath: string; base: string; head: string; maxBytesPerSide: typeof GIT_DIFF_MAX_BYTES_PER_SIDE };

/**
 * The token the Nexus entry (infra/images/common/nexus-entry) splits a multi-step command on. No job value (a manifest
 * argument, a discovered file) may equal it (fix round 1, item 8); planBuilder's STEP_SEPARATOR is this value.
 */
export const STEP_SEPARATOR_TOKEN = '--nexus-then';

/** The most containers and log ranges one diagnosis reads, and the most bytes of one range. */
export const DIAGNOSE_MAX_CONTAINERS = 4;
export const DIAGNOSE_MAX_RANGES = 4;
export const DIAGNOSE_RANGE_MAX_BYTES = 256 * 1024;
/**
 * The vocabularies of a diagnosis, defined once (fix round 1, item 10): the runner's fact extraction, main's
 * re-validation (src/main/nexus/validation/normalized.ts checkDiagnosis) and the report all read these.
 */
export const DIAGNOSE_FACT_STATES = Object.freeze(['created', 'running', 'exited', 'restarting', 'paused', 'dead', 'removing', 'unknown'] as const);
export const DIAGNOSE_CONTAINER_STATUSES = Object.freeze(['inspected', 'missing', 'not_owned', 'unavailable'] as const);
export const DIAGNOSE_LOG_STATUSES = Object.freeze(['read', 'missing', 'refused'] as const);
/** The most characters of the last output line a log range reports. */
export const DIAGNOSE_LAST_TEXT_MAX = 200;

/**
 * What `docker inspect` says about one container, as a diagnosis records it: a fixed set of fields only (never the
 * environment, the mounts' host paths or the labels' values beyond ownership).
 */
export interface DiagnoseContainerFacts {
  state: (typeof DIAGNOSE_FACT_STATES)[number];
  exitCode: number | null; oomKilled: boolean; restartCount: number;
  startedAt: string | null; finishedAt: string | null;
  /** The image's local id, as a digest under a `sha256` key (the redactor's integrity-hash rule; never a bare hex string). */
  image: { sha256: string } | null;
  nanoCpus: number | null; memoryBytes: number | null; pidsLimit: number | null;
  networkMode: string | null; readonlyRootfs: boolean | null; user: string | null; publishedPorts: string[];
}

/** The runner's diagnosis (parser `diagnostic`): main re-validates it, adds its own probe table and stores the report. */
export interface DiagnoseResult {
  target: 'deployment' | 'job';
  /** `container.sha256`: the container id (64 hex, kept under a `sha256` key so the secret check reads it as a digest). */
  containers: { container: { sha256: string }; status: (typeof DIAGNOSE_CONTAINER_STATUSES)[number]; facts: DiagnoseContainerFacts | null }[];
  logs: { attemptId: string; status: (typeof DIAGNOSE_LOG_STATUSES)[number]; offset: number; length: number; sha256: string | null;
    frames: number; errorFrames: number; lastText: string | null }[];
}

export interface EnginePlan extends PlanBase {
  kind: 'engine';
  task: EngineTask;
  wallClockMs: number;
}

/**
 * One agent turn (B2b): the runtime runs on the host under the runner, its file tools confined to the session worktree
 * by policy; every command it runs goes through `sandbox_exec` into `container` (network `none`, the worktree bound at
 * `/workspace`). `runtime.token` is the turn's capability token: it travels only over the MessagePort, never in argv, a
 * file, a log or a database row. `egress.allow`: the hosts the agent process itself may reach through the runner's
 * loopback proxy (the live consent's hosts). `caps`: the turn's limits, already clamped to the consent.
 */
export interface AgentPlan extends PlanBase {
  kind: 'agent';
  container: ContainerSpec;
  worktree: { hostPath: string; gitDir: string; ref: string; base: string; editable: string[] };
  runtime: { kind: RuntimeKind; request: RunRequest; token: string };
  egress: { allow: { host: string; port: number }[] };
  caps: { turnTokens: number; turnUsdCents: number; dayRemainingUsdCents: number; toolCalls: number };
  resourceLabels: ResourceLabels;
}

export type AttemptPlan = ToolPlan | ServicePlan | EnginePlan | AgentPlan;
