/**
 * The nexus:* IPC family: the one place a nexus:* channel is registered. main calls
 * registerNexusIpc once, at module top level, with Electron's IPC registrar; tests pass a fake one.
 *
 * Every channel runs through ONE wrapper, `handler(channel, parse, run)`:
 * 1. Platform check, read at call time (registration happens before whenReady, while
 *    the platform is still null): no platform -> platform_unavailable with the store's
 *    reason; a handoff channel while handoffs are off -> platform_unavailable, reason
 *    'handoffs_unavailable', with the v8 sub-reason.
 * 2. Validation through validate.ts (exact shapes, unknown keys refused; a value whose read throws, such as a Proxy,
 *    is a bad request, never `internal`).
 * 3. The principal: always the local user, resolved here from the store. Nothing
 *    identity-shaped is read from the arguments.
 * 4. One service call, mapped to a view (dto.ts). Authorization stays in the services;
 *    the write channels call the services (and UserSaves, built once per platform
 *    instance over the main source ports) and decide nothing themselves.
 * 5. Errors through envelope.ts. The wrapper never throws.
 *
 * This module lives outside src/main/nexus on purpose: the platform core never knows
 * about transport (the composition test bans Electron's IPC objects there).
 * B1 Task 6 registered the read channels; Task 7 the write channels (all 21).
 *
 * B2a Task 13 adds the twenty execution channels #22-#41 (NEXUS_EXEC_CHANNELS), through the same wrapper, registered
 * when main passes the execution deps (`executionUnavailableReason`, `exec`). Every one except #22 (the domain registry)
 * and #23 (health, from main's cache) first needs schema v9 execution: while it is off they answer platform_unavailable
 * with reason 'execution_unavailable' and its sub-reason (the store's reason, `not_enabled`, `registry_invalid` when the
 * startup registry check failed, `not_started` when main's execution wiring is not running). The renderer sends ids,
 * input slots, an action's own params and an intent ULID; main picks every recipe, image, argv, network and mount.
 * The approval resume and every other system-only operation of the execution core is never reachable from here: an
 * approval is answered only through #39 (once or deny). The one push, nexus:hint, is sent by `sendNexusHint` below.
 */
import type { Principal } from '../../shared/nexus/platform';
import type {
  HandoffsUnavailableSubReason, NexusOk, NexusResult, PlatformUnavailableReason
} from '../../shared/nexus/ipc';
import type { NexusPlatform } from '../nexus/platform';
import type { ExecIpcPort } from '../nexusExec/execWiring';
import type { MergeConfirmInfo } from '../nexus/repo/acceptService';
import { MAX_LIST_LIMIT } from '../nexus/artifact/artifactService';
import { UserSaves, type SaveResult, type SourcePorts } from '../nexus/commands/userSaves';
import { PlatformError } from '../nexus/errors';
import { requireStoredUser } from '../nexus/auth/principals';
import { HANDOFF_STATUSES, MAX_SUBJECTS } from '../nexus/handoff/handoffRules';
import { MAX_LINK_SOURCES } from '../nexus/lineage/lineageService';
import { getUserAction } from '../../shared/nexus/actions';
import { DOMAINS } from '../../shared/nexus/domains/index';
import { fail, ok, unavailable } from './envelope';
import {
  APPROVAL_STATUSES_ACCEPTED, DEPLOYMENT_STATUSES_ACCEPTED, MAX_FOCUS_VERSIONS, PREVIEW_PARTS, RequestError, V
} from './validate';
import {
  acceptResultView, actionView, activityView, approvalView, artifactView, deploymentView, domainView, edgeView, eventView, gcView, handoffDetailView,
  handoffSummaryView, healthView, jobDetailView, jobView, lineageNodeView, logPageView, mergeView, participationView, previewView, repoStatusUnavailable,
  repoStatusView, reviewResultView, sessionDetailView, sessionViewOf, summaryView, validationView, versionDetail, versionView
} from './dto';
import { agentSetupView } from './agentSetup';

/** All 21 nexus:* channels of B1, in the order of the IPC surface table. */
export const NEXUS_CHANNELS: readonly string[] = Object.freeze([
  'nexus:participations:list',
  'nexus:participation:attach',
  'nexus:participation:withdraw',
  'nexus:artifacts:list',
  'nexus:artifacts:byProject',
  'nexus:artifact:get',
  'nexus:version:get',
  'nexus:lineage:get',
  'nexus:artifact:saveCommit',
  'nexus:artifact:saveTextFile',
  'nexus:version:markReady',
  'nexus:version:promote',
  'nexus:version:discard',
  'nexus:version:linkSources',
  'nexus:handoffs:list',
  'nexus:handoff:get',
  'nexus:handoff:send',
  'nexus:handoff:accept',
  'nexus:handoff:decline',
  'nexus:handoff:withdraw',
  'nexus:activity:byProject'
]);

/** Channels 15-20: they also need the handoff service (schema v8). */
const HANDOFF_CHANNELS: ReadonlySet<string> = new Set([
  'nexus:handoffs:list', 'nexus:handoff:get', 'nexus:handoff:send', 'nexus:handoff:accept', 'nexus:handoff:decline', 'nexus:handoff:withdraw'
]);

/** B2a Task 13: the twenty execution channels #22-#41, in the order of the IPC surface table. */
export const NEXUS_EXEC_CHANNELS: readonly string[] = Object.freeze([
  'nexus:domains:list',
  'nexus:platform:health',
  'nexus:actions:available',
  'nexus:job:start',
  'nexus:jobs:list',
  'nexus:job:get',
  'nexus:job:logs',
  'nexus:job:cancel',
  'nexus:job:retry',
  'nexus:events:since',
  'nexus:version:validations',
  'nexus:version:revalidate',
  'nexus:version:preview',
  'nexus:artifact:saveInline',
  'nexus:deployments:list',
  'nexus:deployment:stop',
  'nexus:approvals:list',
  'nexus:approval:respond',
  'nexus:setup:prepareImage',
  'nexus:blobs:gc'
]);
/** Every B1 and B2a nexus:* channel (41): B1's 21 and B2a's 20. */
export const NEXUS_ALL_CHANNELS: readonly string[] = Object.freeze([...NEXUS_CHANNELS, ...NEXUS_EXEC_CHANNELS]);
/**
 * B2b Task 14: the ten agent channels #42-#51, through the same wrapper, registered when main passes the agent deps
 * (`agentsUnavailableReason` or `confirmMerge`, on top of the execution deps). While the agents part is off (schema v10 not
 * on) each answers platform_unavailable with reason 'agents_unavailable' and its sub-reason; #1-#41 are unaffected.
 */
export const NEXUS_AGENT_CHANNELS: readonly string[] = Object.freeze([
  'nexus:agent:start',
  'nexus:sessions:list',
  'nexus:session:get',
  'nexus:session:end',
  'nexus:session:cancel',
  'nexus:review:decide',
  'nexus:changeSet:accept',
  'nexus:repo:status',
  'nexus:repo:mergeAccepted',
  'nexus:agent:consent'
]);
/** Every nexus:* channel main can register (51). */
export const NEXUS_EVERY_CHANNEL: readonly string[] = Object.freeze([...NEXUS_ALL_CHANNELS, ...NEXUS_AGENT_CHANNELS]);
const AGENT_CHANNELS: ReadonlySet<string> = new Set(NEXUS_AGENT_CHANNELS);
/** How long #42 and a #51 grant wait for a fresh runtime probe when the cached health is stale. */
export const RUNTIME_REFRESH_WAIT_MS = 10_000;
/** The one push of the family (main -> renderer): `{ lastSeq }` only. */
export const NEXUS_HINT_CHANNEL = 'nexus:hint';

/** #24-#41: they need schema v9 execution (#22 and #23 answer whenever the platform is up). */
const EXECUTION_CHANNELS: ReadonlySet<string> = new Set(NEXUS_EXEC_CHANNELS.filter((c) => c !== 'nexus:domains:list' && c !== 'nexus:platform:health'));

/** List limits as the renderer may ask for them; a larger integer is clamped to the channel's maximum. */
export const ARTIFACTS_LIST_MAX = 500;
export const HANDOFFS_LIST_MAX = 500;
export const ACTIVITY_PAGE_MAX = 50;
const DEFAULT_LIST = 200;
/** B2a: jobs and events lists (the core's caps), a log or preview page (256 KiB), attempt numbers, preview pages. */
export const JOBS_LIST_MAX = 500;
const DEFAULT_EXEC_LIST = 100;
export const EVENTS_MAX = 500;
export const MAX_READ_PAGE = 262_144;
const MAX_ATTEMPT_N = 1_000_000;
const MAX_PREVIEW_PAGE = 100_000;
/** The widest row cursor of a preview (the junit table holds 5 counts and at most a few hundred cases; a tree 5,000 files). */
const MAX_PREVIEW_ROW = 1_000_000;
const PLATFORM = { type: 'platform' } as const;
/** The widest integer a limit may be before it is refused rather than clamped. */
const LIMIT_CEILING = 100000;

export interface IpcRegistrar { handle(channel: string, fn: (evt: unknown, ...args: unknown[]) => unknown): void }

export interface NexusIpcDeps {
  /** Read at call time: null until the platform started. */
  platform: () => NexusPlatform | null;
  /** Why the platform is unavailable (null once it is up). */
  unavailableReason: () => PlatformUnavailableReason | null;
  /** Why handoffs alone are off while the platform is up; the sub-reason of 'handoffs_unavailable'. */
  handoffsUnavailableReason?: () => HandoffsUnavailableSubReason | string | null;
  /** Main adapters for user saves (project folder, file read, commit resolve); used by the two save channels. */
  sources: SourcePorts;
  log: (line: string) => void;
  /**
   * B2a: why execution is off as main's store says (null when it is on). With this or `exec` given, the execution
   * channels #22-#41 are registered; read at call time, and the platform's own reason (a failed registry check, a
   * shape problem) applies when this says null.
   */
  executionUnavailableReason?: () => string | null;
  /** B2a: main's execution wiring (logs, previews, blob GC through the data home); null until it runs (`not_started`). */
  exec?: () => ExecIpcPort | null;
  /**
   * B2b Task 14: why the agents part is off as main's store says (null when it is on); read at call time. With this (or
   * `confirmMerge`) given, the agent channels #42-#51 are registered; the platform's own state applies when this says null.
   */
  agentsUnavailableReason?: () => string | null;
  /**
   * B2b Task 14: the ONE confirmation of "Merge accepted work": main's own dialog, from the execution handle's `confirmMerge`
   * (index.ts passes it from `startExecution({ mergeDialog })`). It is handed to the accept service as its `confirm` and
   * nowhere else; omitted, every merge is cancelled (a merge is never confirmed on the user's behalf).
   */
  confirmMerge?: (info: MergeConfirmInfo) => Promise<boolean>;
}

/** A renderer the nexus:hint push goes to (main passes its live web contents). */
export interface HintTarget { send(channel: string, payload: unknown): void; isDestroyed?(): boolean }

type Run<A> = (nx: NexusPlatform, me: Principal, a: A) => NexusOk<unknown> | Promise<NexusOk<unknown>>;

/** A limit: undefined -> the default; an integer 1..LIMIT_CEILING -> clamped to `max`; anything else is refused. */
function limitOf(x: unknown, f: string, max: number, dflt: number): number {
  if (x === undefined) return Math.min(dflt, max);
  return Math.min(max, V.int(x, f, 1, LIMIT_CEILING));
}

/** An optional single object argument: undefined is an empty object. */
const optionalObject = <K extends string>(x: unknown, keys: readonly K[]): Record<K, unknown> =>
  V.object(x === undefined ? {} : x, keys, keys);

const saveView = (r: SaveResult) => ({ artifact: artifactView(r.artifact), version: versionView(r.version), created: r.created });

/** The execution sub-reason an execution service would refuse with (the envelope maps it to 'execution_unavailable'). */
const execOffError = (subReason: string): PlatformError =>
  new PlatformError('platform_unavailable', 'execution is not available', { reason: 'execution_unavailable', subReason });
const queriesOf = (nx: NexusPlatform) => nx.queries ?? (() => { throw execOffError(nx.exec.unavailableReason ?? 'not_enabled'); })();
const validationOf = (nx: NexusPlatform) => nx.validation ?? (() => { throw execOffError(nx.exec.unavailableReason ?? 'not_enabled'); })();
const deploymentsOf = (nx: NexusPlatform) => nx.deployments ?? (() => { throw execOffError(nx.exec.unavailableReason ?? 'not_enabled'); })();
const approvalsOf = (nx: NexusPlatform) => nx.approvals ?? (() => { throw execOffError(nx.exec.unavailableReason ?? 'not_enabled'); })();
/** True for an action whose only recipe is the repository snapshot (RepoService checks the folder first). */
const snapshotAction = (actionId: string): boolean => {
  const a = getUserAction(actionId);
  return !!a && 'recipes' in a.run && a.run.recipes.length === 1 && a.run.recipes[0] === 'repo.snapshot';
};

export function registerNexusIpc(registrar: IpcRegistrar, deps: NexusIpcDeps): void {
  const execution = deps.executionUnavailableReason !== undefined || deps.exec !== undefined;
  /** Why execution is off now (main's store first, then the platform's own reason), or null while it is on. */
  const executionOff = (nx: NexusPlatform): string | null => {
    let main: string | null;
    try { const r = deps.executionUnavailableReason?.(); main = typeof r === 'string' && r.length > 0 ? r : null; } catch { main = 'not_enabled'; }
    if (main) return main;
    return nx.executionAvailable ? null : (nx.exec.unavailableReason ?? 'not_enabled');
  };
  const agentsRegistered = execution && (deps.agentsUnavailableReason !== undefined || deps.confirmMerge !== undefined);
  /** The refusing confirmation used when main wired no dialog: a merge is cancelled, never confirmed by default. */
  const confirmMerge: (info: MergeConfirmInfo) => Promise<boolean> = deps.confirmMerge ?? (async () => false);
  /** Why the agents part is off now (main's store, then execution's, then the platform's own state), or null while it is on. */
  const agentsOff = (nx: NexusPlatform): string | null => {
    let main: string | null;
    try { const r = deps.agentsUnavailableReason?.(); main = typeof r === 'string' && r.length > 0 ? r : null; } catch { main = 'not_enabled'; }
    if (main) return main;
    const ex = executionOff(nx);
    if (ex !== null) return ex;
    return nx.agentsAvailable && nx.agents && nx.reviews && nx.accepts && nx.budget ? null : 'not_enabled';
  };
  const portOf = (): ExecIpcPort => {
    let port: ExecIpcPort | null = null;
    try { port = deps.exec?.() ?? null; } catch { port = null; }
    if (!port) throw execOffError('not_started');
    return port;
  };
  // UserSaves is built lazily, once per platform instance (the platform object changes only across a restart).
  const savers = new WeakMap<NexusPlatform, UserSaves>();
  const userSaves = (nx: NexusPlatform): UserSaves => {
    let u = savers.get(nx);
    if (!u) { u = new UserSaves(nx, deps.sources); savers.set(nx, u); }
    return u;
  };
  const handler = <A>(channel: string, parse: (args: unknown[]) => A, run: Run<A>) => {
    const needsHandoffs = HANDOFF_CHANNELS.has(channel);
    const needsExecution = EXECUTION_CHANNELS.has(channel);
    const needsAgents = AGENT_CHANNELS.has(channel);
    return async (_evt: unknown, ...args: unknown[]): Promise<NexusResult<unknown>> => {
      try {
        const nx = deps.platform();
        if (!nx) return unavailable(deps.unavailableReason() ?? 'not_open');
        if (needsHandoffs && !nx.handoffs) return unavailable('handoffs_unavailable', deps.handoffsUnavailableReason?.() ?? null);
        if (needsExecution) {
          const off = executionOff(nx);
          if (off !== null) return unavailable('execution_unavailable', off);
        }
        if (needsAgents) {
          const off = agentsOff(nx);
          if (off !== null) return unavailable('agents_unavailable', off);
        }
        let a: A;
        // A renderer value whose read throws anything but a RequestError (an exotic object) is a bad request (fix round 1).
        try { a = parse(args); } catch (e) { throw e instanceof RequestError ? e : new RequestError('arguments', 'could not be read'); }
        const me = nx.principals.localUser();
        return await run(nx, me, a);
      } catch (e) {
        return fail(e, channel, deps.log);
      }
    };
  };
  const seen = new Set<string>();
  const reg = <A>(channel: string, parse: (args: unknown[]) => A, run: Run<A>): void => {
    if (!NEXUS_EVERY_CHANNEL.includes(channel) || seen.has(channel)) throw new Error(`nexus ipc: unexpected channel ${channel}`);
    seen.add(channel);
    registrar.handle(channel, handler(channel, parse, run));
  };

  // #1 every participation of every project the user may read, every status.
  reg('nexus:participations:list', (args) => { V.arity(args, 0); },
    (nx, me) => ok(nx.workspaces.listForReader(me).map(participationView), false));

  // #2 attach the project to another workspace (non-primary; idempotent, a withdrawn row is re-activated).
  reg('nexus:participation:attach', (args) => {
    V.arity(args, 2);
    return { projectId: V.projectId(args[0]), workspaceId: V.workspaceId(args[1]) };
  }, (nx, me, q) => ok(participationView(nx.workspaces.attach(me, q.projectId, q.workspaceId))));

  // #3 withdraw a non-primary participation (refused while it has live work or open handoffs).
  reg('nexus:participation:withdraw', (args) => { V.arity(args, 1); return V.platformId(args[0], 'participationId'); },
    (nx, me, participationId) => ok(participationView(nx.workspaces.withdraw(me, participationId))));

  // #4 artifacts across projects, newest update first.
  reg('nexus:artifacts:list', (args) => {
    V.arity(args, 1);
    const o = optionalObject(args[0], ['projectId', 'workspaceId', 'kind', 'status', 'limit'] as const);
    return {
      projectId: o.projectId === undefined ? undefined : V.projectId(o.projectId),
      workspaceId: o.workspaceId === undefined ? undefined : V.workspaceId(o.workspaceId),
      kind: o.kind === undefined ? undefined : V.artifactKind(o.kind, 'kind'),
      status: o.status === undefined ? undefined : V.enumOf(o.status, 'status', ['active', 'archived'] as const),
      limit: limitOf(o.limit, 'limit', ARTIFACTS_LIST_MAX, DEFAULT_LIST)
    };
  }, (nx, me, f) => {
    const filter: Record<string, unknown> = { limit: f.limit + 1 };
    if (f.projectId !== undefined) filter.projectId = f.projectId;
    if (f.workspaceId !== undefined) filter.workspaceId = f.workspaceId;
    if (f.kind !== undefined) filter.kind = f.kind;
    if (f.status !== undefined) filter.status = f.status;
    const rows = nx.artifacts.listForReader(me, filter);
    return ok(rows.slice(0, f.limit).map(summaryView), rows.length > f.limit);
  });

  // #5 every artifact of a project with its latest and current version, at most MAX_LIST_LIMIT. One more row is
  // asked for, so `truncated` is true only when more rows really exist.
  reg('nexus:artifacts:byProject', (args) => { V.arity(args, 1); return V.projectId(args[0]); }, (nx, me, projectId) => {
    const rows = nx.artifacts.summariesByProject(me, projectId, { limit: MAX_LIST_LIMIT + 1 });
    return ok(rows.slice(0, MAX_LIST_LIMIT).map(summaryView), rows.length > MAX_LIST_LIMIT);
  });

  // #6 one artifact with all its versions (no content).
  reg('nexus:artifact:get', (args) => { V.arity(args, 1); return V.platformId(args[0], 'artifactId'); }, (nx, me, artifactId) => {
    const artifact = nx.artifacts.get(me, artifactId);
    const versions = nx.artifacts.listVersions(me, artifact.id);
    return ok({ artifact: artifactView(artifact), versions: versions.map(versionView) });
  });

  // #7 one version with its content: the commit of a git version, the text of a text file.
  reg('nexus:version:get', (args) => { V.arity(args, 1); return V.platformId(args[0], 'versionId'); }, (nx, me, versionId) => {
    const v = nx.artifacts.getVersion(me, versionId);
    const a = nx.artifacts.get(me, v.artifactId);
    return ok(versionDetail(a.kind, v));
  });

  // #8 lineage of a version, one direction, depth 1..6.
  reg('nexus:lineage:get', (args) => {
    V.arity(args, 2);
    const versionId = V.platformId(args[0], 'versionId');
    const o = V.object(args[1], ['direction', 'depth'] as const, ['depth'] as const);
    return {
      versionId,
      direction: V.enumOf(o.direction, 'direction', ['up', 'down'] as const),
      depth: o.depth === undefined ? undefined : V.int(o.depth, 'depth', 1, 6)
    };
  }, (nx, me, q) => {
    const opts = q.depth === undefined ? { depth: 6 } : { depth: q.depth };
    const walk = q.direction === 'up' ? nx.lineage.upstream(me, q.versionId, opts) : nx.lineage.downstream(me, q.versionId, opts);
    return ok({ nodes: walk.nodes.map(lineageNodeView), truncated: walk.truncated }, walk.truncated);
  });

  // #9 save a commit of the project repository as a git_commit version (new artifact or append), one transaction.
  reg('nexus:artifact:saveCommit', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['projectId', 'workspaceId', 'commit', 'target'] as const);
    return { projectId: V.projectId(o.projectId), workspaceId: V.workspaceId(o.workspaceId), commit: V.commit(o.commit), target: V.saveTarget(o.target) };
  }, async (nx, me, q) => ok(saveView(await userSaves(nx).saveCommit(me, q))));

  // #10 save a small text file of the project folder as a text_file version, one transaction.
  reg('nexus:artifact:saveTextFile', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['projectId', 'workspaceId', 'relPath', 'target'] as const);
    return { projectId: V.projectId(o.projectId), workspaceId: V.workspaceId(o.workspaceId), relPath: V.relPath(o.relPath), target: V.saveTarget(o.target) };
  }, async (nx, me, q) => ok(saveView(await userSaves(nx).saveTextFile(me, q))));

  // #11 mark a user draft ready (draft -> candidate, finalized by the system on the user's behalf).
  reg('nexus:version:markReady', (args) => { V.arity(args, 1); return V.platformId(args[0], 'versionId'); },
    (nx, me, versionId) => ok(versionView(nx.artifacts.markReady(me, versionId))));

  // #12 promote a candidate, or roll back to a version that was active before; compare-and-set on the current pointer.
  reg('nexus:version:promote', (args) => {
    V.arity(args, 2);
    return { versionId: V.platformId(args[0], 'versionId'), expected: V.idOrNull(args[1], 'expectedCurrentVersionId') };
  }, (nx, me, q) => {
    const r = nx.artifacts.promote(me, q.versionId, q.expected);
    if (!r.ok) throw new PlatformError('conflict', 'the current version changed; reload and try again', { currentVersionId: r.currentVersionId });
    return ok(versionView(r.version));
  });

  // #13 discard a draft or a candidate.
  reg('nexus:version:discard', (args) => { V.arity(args, 1); return V.platformId(args[0], 'versionId'); },
    (nx, me, versionId) => ok(versionView(nx.artifacts.discard(me, versionId))));

  // #14 record the versions a version was derived from (1 to 20, all or nothing).
  reg('nexus:version:linkSources', (args) => {
    V.arity(args, 2);
    return { versionId: V.platformId(args[0], 'versionId'), sources: V.idList(args[1], 'sourceVersionIds', MAX_LINK_SOURCES) };
  }, (nx, me, q) => {
    const r = nx.lineage.linkSources(me, q.versionId, q.sources);
    return ok({ edges: r.edges.map(edgeView), created: r.created });
  });

  // #15 handoffs the user may read: inbox, sent or all; open first, then newest.
  reg('nexus:handoffs:list', (args) => {
    V.arity(args, 1);
    const o = optionalObject(args[0], ['projectId', 'workspaceId', 'box', 'status', 'limit'] as const);
    return {
      projectId: o.projectId === undefined ? undefined : V.projectId(o.projectId),
      workspaceId: o.workspaceId === undefined ? undefined : V.workspaceId(o.workspaceId),
      box: o.box === undefined ? undefined : V.enumOf(o.box, 'box', ['inbox', 'sent', 'all'] as const),
      status: o.status === undefined ? undefined : V.enumOf(o.status, 'status', HANDOFF_STATUSES),
      limit: limitOf(o.limit, 'limit', HANDOFFS_LIST_MAX, DEFAULT_LIST)
    };
  }, (nx, me, f) => {
    const filter: Record<string, unknown> = { limit: f.limit + 1 };
    if (f.projectId !== undefined) filter.projectId = f.projectId;
    if (f.workspaceId !== undefined) filter.workspaceId = f.workspaceId;
    if (f.box !== undefined) filter.box = f.box;
    if (f.status !== undefined) filter.status = f.status;
    const rows = nx.handoffs!.list(me, filter);
    return ok(rows.slice(0, f.limit).map(handoffSummaryView), rows.length > f.limit);
  });

  // #16 one handoff with its subjects.
  reg('nexus:handoff:get', (args) => { V.arity(args, 1); return V.platformId(args[0], 'handoffId'); },
    (nx, me, handoffId) => ok(handoffDetailView(nx.handoffs!.get(me, handoffId))));

  // #17 send candidate or active versions from one participation to another of the same project.
  reg('nexus:handoff:send', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['projectId', 'fromParticipationId', 'toParticipationId', 'versionIds', 'title', 'note'] as const, ['note'] as const);
    const q = {
      projectId: V.projectId(o.projectId),
      fromParticipationId: V.platformId(o.fromParticipationId, 'fromParticipationId'),
      toParticipationId: V.platformId(o.toParticipationId, 'toParticipationId'),
      versionIds: V.idList(o.versionIds, 'versionIds', MAX_SUBJECTS),
      title: V.title(o.title, 'title')
    };
    const note = V.note(o.note);
    return note === undefined ? q : { ...q, note };
  }, (nx, me, q) => {
    const r = nx.handoffs!.send(me, q);
    return ok({ handoff: handoffDetailView(r.handoff), created: r.created });
  });

  // #18 accept: a receipt in the receiving participation that depends on each subject; one transaction.
  reg('nexus:handoff:accept', (args) => { V.arity(args, 1); return V.platformId(args[0], 'handoffId'); },
    (nx, me, handoffId) => ok(handoffDetailView(nx.handoffs!.accept(me, handoffId))));

  // #19 decline, with an optional note.
  reg('nexus:handoff:decline', (args) => {
    V.arity(args, 2);
    return { handoffId: V.platformId(args[0], 'handoffId'), note: V.note(args[1]) };
  }, (nx, me, q) => ok(handoffDetailView(nx.handoffs!.decline(me, q.handoffId, q.note))));

  // #20 withdraw an unanswered handoff (the sender's side).
  reg('nexus:handoff:withdraw', (args) => { V.arity(args, 1); return V.platformId(args[0], 'handoffId'); },
    (nx, me, handoffId) => ok(handoffDetailView(nx.handoffs!.withdraw(me, handoffId))));

  // #21 a project's activity, newest first, details reduced to an allow-list.
  reg('nexus:activity:byProject', (args) => {
    V.arity(args, 2);
    const projectId = V.projectId(args[0]);
    const o = optionalObject(args[1], ['beforeSeq', 'limit'] as const);
    return {
      projectId,
      beforeSeq: o.beforeSeq === undefined ? undefined : V.int(o.beforeSeq, 'beforeSeq', 1, Number.MAX_SAFE_INTEGER),
      limit: limitOf(o.limit, 'limit', ACTIVITY_PAGE_MAX, ACTIVITY_PAGE_MAX)
    };
  }, (nx, me, q) => {
    // The project must exist ('not_found') and be readable ('denied', audited) before its rows are listed.
    nx.projects.require(me, q.projectId, 'activity.read');
    const rows = nx.activity.list(me, { projectId: q.projectId, beforeSeq: q.beforeSeq, limit: q.limit + 1 });
    return ok(rows.slice(0, q.limit).map(activityView), rows.length > q.limit);
  });

  // ---------- B2a Task 13: the execution channels #22-#41 (registered when main passes the execution deps) ----------
  if (!execution) return;

  // #22 the domain registry as the renderer shows it: lifecycle steps with REAL / PARTIAL / FUTURE, never a result.
  // A stored, enabled user only (fix round 1): an agent, the system or a disabled user is denied and audited.
  reg('nexus:domains:list', (args) => { V.arity(args, 0); }, (nx, me) => {
    requireStoredUser(nx.principals, nx.auth, me, 'workspace.read', 'workspace', 'only a user reads the domain registry');
    return ok(DOMAINS.map(domainView));
  });

  // #23 the execution setup from main's cache (never waits on Docker or the runner): the gate with its exact numbers.
  // `{ probe: true }` (the setup sheet's "Check again", B2a final review C3) also asks the runner for a fresh probe, at
  // most once per 5 s (ExecutionService.requestProbe); the answer is still the cache, the fresh probe lands later.
  reg('nexus:platform:health', (args) => {
    V.arity(args, 1);
    if (args[0] === undefined) return { probe: false };
    const o = V.object(args[0], ['probe'] as const);
    if (o.probe !== true) throw new RequestError('probe', 'must be true');
    return { probe: true };
  }, (nx, me, q) => {
    nx.auth.require(me, 'platform.health', PLATFORM, { entityType: 'platform' });
    if (q.probe) nx.exec.requestProbe();
    const off = executionOff(nx);
    return ok(healthView(nx.exec.health(), { handoffs: nx.handoffsAvailable, execution: off === null, registry: nx.registry, subReason: off }, agentSetupView(nx)));
  });

  // #24 the domain's actions with whether each can run now and why not.
  reg('nexus:actions:available', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['projectId', 'workspaceId', 'versionId'] as const, ['versionId'] as const);
    const q = { projectId: V.projectId(o.projectId), workspaceId: V.workspaceId(o.workspaceId) };
    return o.versionId === undefined ? q : { ...q, versionId: V.platformId(o.versionId, 'versionId') };
  }, (nx, me, q) => ok(queriesOf(nx).actionsFor(me, q).map(actionView)));

  // #25 start an action: ids, input slots, the action's own params and the intent; main picks the recipe, the image,
  // the argv, the network and every mount. A repository snapshot goes through RepoService (the folder is checked first).
  reg('nexus:job:start', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['projectId', 'workspaceId', 'actionId', 'inputs', 'params', 'intentId'] as const);
    const actionId = V.actionId(o.actionId);
    return { projectId: V.projectId(o.projectId), workspaceId: V.workspaceId(o.workspaceId), actionId, inputs: V.jobInputs(o.inputs),
      params: V.actionParams(actionId, o.params), intentId: V.intentId(o.intentId) };
  }, async (nx, me, q) => {
    if (nx.repo && snapshotAction(q.actionId)) {
      if (q.inputs.length > 0) throw new PlatformError('invalid', 'a snapshot takes no input', { reason: 'input_not_allowed' });
      const r = await nx.repo.requestSnapshot(me, { projectId: q.projectId, workspaceId: q.workspaceId, intentId: q.intentId });
      return ok({ job: jobView(nx.exec.get(me, r.job.id)), created: r.created });
    }
    const r = nx.exec.start(me, { ...q, params: { ...q.params } });
    return ok({ job: jobView(r.job), created: r.created });
  });

  // #26 jobs the user may read, newest first.
  reg('nexus:jobs:list', (args) => {
    V.arity(args, 1);
    const o = optionalObject(args[0], ['projectId', 'workspaceId', 'states', 'jobKind', 'limit'] as const);
    return {
      projectId: o.projectId === undefined ? undefined : V.projectId(o.projectId),
      workspaceId: o.workspaceId === undefined ? undefined : V.workspaceId(o.workspaceId),
      states: o.states === undefined ? undefined : V.jobStates(o.states),
      jobKind: o.jobKind === undefined ? undefined : V.jobKind(o.jobKind),
      limit: limitOf(o.limit, 'limit', JOBS_LIST_MAX, DEFAULT_EXEC_LIST)
    };
  }, (nx, me, f) => {
    const filter: Record<string, unknown> = { limit: f.limit };
    if (f.projectId !== undefined) filter.projectId = f.projectId;
    if (f.workspaceId !== undefined) filter.workspaceId = f.workspaceId;
    if (f.states !== undefined) filter.states = f.states;
    if (f.jobKind !== undefined) filter.jobKind = f.jobKind;
    const r = nx.exec.list(me, filter as Parameters<typeof nx.exec.list>[1]);
    return ok(r.jobs.map(jobView), r.truncated);
  });

  // #27 one job with its attempts, outputs, approvals and deployment.
  reg('nexus:job:get', (args) => { V.arity(args, 1); return V.platformId(args[0], 'jobId'); },
    (nx, me, jobId) => ok(jobDetailView(nx.exec.get(me, jobId))));

  // #28 a page of one attempt's stored log, redacted again on read (the location comes from the attempt row only).
  reg('nexus:job:logs', (args) => {
    V.arity(args, 2);
    const jobId = V.platformId(args[0], 'jobId');
    const o = V.object(args[1], ['attempt', 'fromOffset', 'maxBytes'] as const);
    return { jobId, attempt: V.int(o.attempt, 'attempt', 1, MAX_ATTEMPT_N), fromOffset: V.int(o.fromOffset, 'fromOffset', 0, Number.MAX_SAFE_INTEGER),
      maxBytes: V.int(o.maxBytes, 'maxBytes', 1, MAX_READ_PAGE) };
  }, async (nx, me, q) => ok(logPageView(await portOf().logs(me, q.jobId, { attempt: q.attempt, fromOffset: q.fromOffset, maxBytes: q.maxBytes }))));

  // #29 cancel a live job (its children first; a pending approval is withdrawn).
  reg('nexus:job:cancel', (args) => { V.arity(args, 1); return V.platformId(args[0], 'jobId'); },
    (nx, me, jobId) => ok(jobView(nx.exec.cancel(me, jobId))));

  // #30 retry a finished job as a new job (retry_of), once per intent.
  reg('nexus:job:retry', (args) => {
    V.arity(args, 2);
    return { jobId: V.platformId(args[0], 'jobId'), intentId: V.intentId(args[1]) };
  }, (nx, me, q) => ok({ job: jobView(nx.exec.retry(me, q.jobId, q.intentId).job) }));

  // #31 job events after a seq (what the nexus:hint push says changed).
  reg('nexus:events:since', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['sinceSeq', 'projectId', 'limit'] as const, ['projectId', 'limit'] as const);
    return { sinceSeq: V.int(o.sinceSeq, 'sinceSeq', 0, Number.MAX_SAFE_INTEGER),
      projectId: o.projectId === undefined ? undefined : V.projectId(o.projectId), limit: limitOf(o.limit, 'limit', EVENTS_MAX, EVENTS_MAX) };
  }, (nx, me, q) => {
    const r = nx.exec.eventsSince(me, q.projectId === undefined ? { sinceSeq: q.sinceSeq, limit: q.limit } : { sinceSeq: q.sinceSeq, projectId: q.projectId, limit: q.limit });
    return ok({ events: r.events.map(eventView), lastSeq: r.lastSeq });
  });

  // #32 a version's checks: the latest BLOCKING row per validator is its status; advisory runs are shown apart.
  reg('nexus:version:validations', (args) => { V.arity(args, 1); return V.platformId(args[0], 'versionId'); },
    (nx, me, versionId) => ok(queriesOf(nx).validationsFor(me, versionId).map(validationView)));

  // #33 run a draft's blocking checks again (a live check of the same validator is the answer, never a second one).
  reg('nexus:version:revalidate', (args) => {
    V.arity(args, 2);
    return { versionId: V.platformId(args[0], 'versionId'), intentId: V.intentId(args[1]) };
  }, (nx, me, q) => {
    // The intent goes through: a re-sent intent returns the same checks and queues nothing (fix round 1).
    const r = validationOf(nx).revalidate(me, q.versionId, q.intentId);
    return ok({ jobs: r.jobs.map((id) => jobView(nx.exec.get(me, id))) });
  });

  // #34 a page of what a version holds (text redacted again, rows capped), at most 256 KiB per page. The text part pages
  // by `page`; the row parts by a row cursor, `fromRow` (fix round 1: a page the byte cap ends early never skips a row).
  reg('nexus:version:preview', (args) => {
    V.arity(args, 2);
    const versionId = V.platformId(args[0], 'versionId');
    const o = V.object(args[1], ['part', 'page', 'fromRow', 'maxBytes'] as const, ['page', 'fromRow'] as const);
    const part = V.enumOf(o.part, 'part', PREVIEW_PARTS);
    const textPart = part === 'content' || part === 'diff';
    if (textPart && o.fromRow !== undefined) throw new RequestError('fromRow', 'pages the row parts only');
    if (!textPart && o.page !== undefined) throw new RequestError('page', 'pages the text parts only');
    return { versionId, part, page: o.page === undefined ? 0 : V.int(o.page, 'page', 0, MAX_PREVIEW_PAGE),
      fromRow: o.fromRow === undefined ? 0 : V.int(o.fromRow, 'fromRow', 0, MAX_PREVIEW_ROW), maxBytes: V.int(o.maxBytes, 'maxBytes', 1, MAX_READ_PAGE) };
  }, async (nx, me, q) => ok(previewView(await portOf().preview(me, q.versionId, { part: q.part, page: q.page, fromRow: q.fromRow, maxBytes: q.maxBytes }))));

  // #35 save a requirement or a problem statement the user wrote (a draft; its register checks recorded).
  reg('nexus:artifact:saveInline', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['projectId', 'workspaceId', 'kind', 'target', 'content'] as const);
    return {
      projectId: V.projectId(o.projectId), workspaceId: V.workspaceId(o.workspaceId),
      kind: V.userAuthorableKind(o.kind, 'kind'),
      target: V.saveTarget(o.target), content: V.inlineContent(o.content)
    };
  }, (nx, me, q) => ok(saveView(nx.artifacts.saveInline(me, q as Parameters<typeof nx.artifacts.saveInline>[1]))));

  // #36 dev deployments the user may read.
  reg('nexus:deployments:list', (args) => {
    V.arity(args, 1);
    const o = optionalObject(args[0], ['projectId', 'status'] as const);
    const f: { projectId?: string; status?: (typeof DEPLOYMENT_STATUSES_ACCEPTED)[number] } = {};
    if (o.projectId !== undefined) f.projectId = V.projectId(o.projectId);
    if (o.status !== undefined) f.status = V.enumOf(o.status, 'status', DEPLOYMENT_STATUSES_ACCEPTED);
    return f;
  }, (nx, me, f) => {
    const r = deploymentsOf(nx).list(me, f);
    return ok(r.deployments.map(deploymentView), r.truncated);
  });

  // #37 stop a dev deployment (a user only).
  reg('nexus:deployment:stop', (args) => { V.arity(args, 1); return V.platformId(args[0], 'deploymentId'); },
    (nx, me, deploymentId) => ok(deploymentView(deploymentsOf(nx).stop(me, deploymentId))));

  // #38 approvals the user may read, newest first.
  reg('nexus:approvals:list', (args) => {
    V.arity(args, 1);
    const o = optionalObject(args[0], ['projectId', 'status'] as const);
    const f: { projectId?: string; status?: (typeof APPROVAL_STATUSES_ACCEPTED)[number] } = {};
    if (o.projectId !== undefined) f.projectId = V.projectId(o.projectId);
    if (o.status !== undefined) f.status = V.enumOf(o.status, 'status', APPROVAL_STATUSES_ACCEPTED);
    return f;
  }, (nx, me, f) => {
    const r = approvalsOf(nx).list(me, f);
    return ok(r.approvals.map(approvalView), r.truncated);
  });

  // #39 the user's answer: once or deny (there is no 'always'). The one door to a waiting job's plan: the service
  // consumes the approval for the job's current attempt and resumes it; nothing else here can resume a job.
  reg('nexus:approval:respond', (args) => {
    V.arity(args, 2);
    return { approvalId: V.platformId(args[0], 'approvalId'), decision: V.decision(args[1]) };
  }, (nx, me, q) => ok(approvalView(approvalsOf(nx).respond(me, q.approvalId, q.decision))));

  // #40 ask to prepare a sandbox image (an approval the user answers with #39).
  reg('nexus:setup:prepareImage', (args) => {
    V.arity(args, 2);
    return { profileId: V.imageProfile(args[0]), intentId: V.intentId(args[1]) };
  }, (nx, me, q) => {
    const r = approvalsOf(nx).requestImage(me, q.profileId, q.intentId);
    return ok({ approval: approvalView(r.approval), created: r.created });
  });

  // #41 blob GC: a dry run, then the apply with the dry run's hash (refused when the candidates changed). Authorized
  // like every channel (the wrapper, then blob.gc platform-wide in the service; a denial is audited).
  reg('nexus:blobs:gc', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['apply', 'expectedCandidatesHash'] as const, ['expectedCandidatesHash'] as const);
    if (o.apply === false) {
      if (o.expectedCandidatesHash !== undefined) throw new RequestError('expectedCandidatesHash', 'is sent only with apply: true');
      return { apply: false as const };
    }
    if (o.apply !== true) throw new RequestError('apply', 'must be true or false');
    return { apply: true as const, expectedCandidatesHash: V.sha256(o.expectedCandidatesHash, 'expectedCandidatesHash') };
  }, async (nx, me, q) => ok(gcView(await portOf().blobsGc(me, q))));

  // ---------- B2b Task 14: the agent channels #42-#51 (registered when main passes the agent deps) ----------
  if (!agentsRegistered) return;

  // #42 start an agent turn (or continue a conversation). Ids, the message, the focus versions and the intent only: the
  // runner, the runtime, the network, the model and every folder are main's. A stale runtime health is refreshed first.
  reg('nexus:agent:start', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['projectId', 'workspaceId', 'sessionId', 'skillId', 'focusVersionIds', 'message', 'intentId'] as const, ['skillId'] as const);
    const q = {
      projectId: V.projectId(o.projectId), workspaceId: V.workspaceId(o.workspaceId), sessionId: V.idOrNull(o.sessionId, 'sessionId'),
      focusVersionIds: V.idListOrEmpty(o.focusVersionIds, 'focusVersionIds', MAX_FOCUS_VERSIONS), message: V.agentMessage(o.message), intentId: V.intentId(o.intentId)
    };
    return o.skillId === undefined ? q : { ...q, skillId: V.skillId(o.skillId) };
  }, async (nx, me, q) => {
    // The cached health is bounded in age: a stale one is refreshed (bounded wait) before the start is judged.
    if (nx.agentProbe && nx.agentProbe.cache.isStale()) await nx.agentProbe.refreshAndWait(RUNTIME_REFRESH_WAIT_MS);
    const r = nx.agents!.start(me, q);
    const detail = await nx.agents!.get(me, r.session.id);
    return ok({ session: sessionViewOf(detail), job: jobView(nx.exec.get(me, r.job.id)) });
  });

  // #43 a project's agent conversations (newest first), from the database only.
  reg('nexus:sessions:list', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['projectId', 'statuses'] as const, ['statuses'] as const);
    return { projectId: V.projectId(o.projectId), statuses: o.statuses === undefined ? undefined : V.sessionStatuses(o.statuses) };
  }, (nx, me, q) => {
    const rows = nx.agents!.list(me, q.projectId);
    return ok(q.statuses === undefined ? rows : rows.filter((s) => q.statuses!.includes(s.status)), false);
  });

  // #44 one conversation: turns, display-only messages, tool calls (name and size), registered versions, approvals.
  reg('nexus:session:get', (args) => { V.arity(args, 1); return V.platformId(args[0], 'sessionId'); },
    async (nx, me, sessionId) => ok(sessionDetailView(await nx.agents!.get(me, sessionId))));

  // #45 end the conversation (a live turn is cancelled first).
  reg('nexus:session:end', (args) => { V.arity(args, 1); return V.platformId(args[0], 'sessionId'); }, async (nx, me, sessionId) => {
    const s = nx.agents!.end(me, sessionId);
    return ok(sessionViewOf(await nx.agents!.get(me, s.id)));
  });

  // #46 cancel the conversation's live turn (the conversation stays open).
  reg('nexus:session:cancel', (args) => { V.arity(args, 1); return V.platformId(args[0], 'sessionId'); }, async (nx, me, sessionId) => {
    nx.agents!.cancel(me, sessionId);
    return ok(sessionViewOf(await nx.agents!.get(me, sessionId)));
  });

  // #47 a review decision on a change set candidate; a request for changes starts the next turn in the same transaction.
  reg('nexus:review:decide', (args) => {
    V.arity(args, 3);
    const o = V.object(args[1], ['decision', 'comment'] as const, ['comment'] as const);
    const decision = V.enumOf(o.decision, 'decision', ['approve', 'request_changes', 'reject'] as const);
    const comment = V.reviewComment(o.comment);
    return { versionId: V.platformId(args[0], 'versionId'), decision, comment, intentId: V.intentId(args[2]) };
  }, (nx, me, q) => {
    const r = nx.reviews!.decide(me, q.versionId, q.comment === undefined ? { decision: q.decision, intentId: q.intentId }
      : { decision: q.decision, comment: q.comment, intentId: q.intentId });
    return ok(reviewResultView(r.review, r.job ? jobView(nx.exec.get(me, r.job.id)) : null));
  });

  // #48 accept an approved change set into the integration ref (never the user's branch); compare-and-set on the head the user saw.
  reg('nexus:changeSet:accept', (args) => {
    V.arity(args, 2);
    return { versionId: V.platformId(args[0], 'versionId'), expectedIntegrationHead: V.commitId(args[1], 'expectedIntegrationHead') };
  }, async (nx, me, q) => {
    const r = await nx.accepts!.accept(me, q.versionId, q.expectedIntegrationHead);
    return ok(acceptResultView(versionView(r.version), r.accept));
  });

  // #49 the repository as the accept and merge flows see it. A repository that cannot be read answers a status that says why.
  reg('nexus:repo:status', (args) => { V.arity(args, 1); return V.projectId(args[0]); }, async (nx, me, projectId) => {
    try {
      return ok(repoStatusView(projectId, await nx.accepts!.status(me, projectId), Date.now()));
    } catch (e) {
      const reason = e instanceof PlatformError && e.code === 'unavailable' && e.detail && typeof e.detail.reason === 'string' ? e.detail.reason : null;
      if (reason === null) throw e;
      return ok(repoStatusUnavailable(projectId, reason, Date.now()));
    }
  });

  // #50 "Merge accepted work": a dialog-confirmed fast-forward. The ONLY confirmation is main's own dialog (`confirmMerge`, from
  // main's execution handle); nothing the renderer sends can stand in for it, and with no dialog wired every merge is cancelled.
  reg('nexus:repo:mergeAccepted', (args) => {
    V.arity(args, 2);
    const o = V.object(args[1], ['branch', 'expectedAcceptedHead'] as const);
    return { projectId: V.projectId(args[0]), branch: V.branchName(o.branch), expectedAcceptedHead: V.commitId(o.expectedAcceptedHead, 'expectedAcceptedHead') };
  }, async (nx, me, q) => {
    const r = await nx.accepts!.mergeAccepted(me, q.projectId, { branch: q.branch, expectedAcceptedHead: q.expectedAcceptedHead }, confirmMerge);
    return ok(mergeView(r.merge));
  });

  // #51 the agent's network permission. `grant` carries caps only (clamped to the D-B4 ceilings by the service); the destinations
  // come from the runtime's own probe, never from the renderer. Owner role (the service checks); `revoke` ends it.
  reg('nexus:agent:consent', (args) => {
    V.arity(args, 1);
    const o = V.object(args[0], ['op', 'caps'] as const, ['caps'] as const);
    const op = V.enumOf(o.op, 'op', ['get', 'grant', 'revoke'] as const);
    if (op !== 'grant') {
      if (o.caps !== undefined) throw new RequestError('caps', 'is sent only with grant');
      return { op };
    }
    return { op, caps: o.caps === undefined ? {} : V.consentCaps(o.caps) };
  }, async (nx, me, q) => {
    const probe = nx.agentProbe;
    if (q.op === 'get') {
      nx.auth.require(me, 'platform.health', PLATFORM, { entityType: 'platform' });
      if (probe && probe.cache.isStale()) probe.refresh();
      return ok(agentSetupView(nx));
    }
    if (q.op === 'revoke') {
      nx.budget!.revoke(me);
      probe?.refresh();
      return ok(agentSetupView(nx));
    }
    // The hosts and the kind are the adapter's own, as the runner's probe reported them (refreshed first when stale).
    if (probe && probe.cache.isStale()) await probe.refreshAndWait(RUNTIME_REFRESH_WAIT_MS);
    const seen = probe?.cache.fresh() ?? null;
    const hosts = probe?.cache.egressHosts() ?? null;
    if (!seen || !hosts || hosts.length === 0) {
      throw new PlatformError('unavailable', 'the agent has not been checked on this computer yet', { reason: 'runtime_unknown' });
    }
    nx.budget!.grant(me, { runtimeKind: seen.kind, hosts, caps: q.caps });
    probe?.refresh();
    return ok(agentSetupView(nx));
  });
}

/**
 * The nexus:hint push (B2a Task 13): main -> renderer, `{ lastSeq }` only, coalesced to at most 4 per second by main's
 * execution wiring (hintCoalescer), which calls this with each live target. The one push of the nexus family and the
 * only place it is sent. Never throws; false when nothing was sent.
 */
export function sendNexusHint(target: HintTarget, lastSeq: number): boolean {
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) return false;
  try {
    if (typeof target?.isDestroyed === 'function' && target.isDestroyed()) return false;
    target.send(NEXUS_HINT_CHANNEL, { lastSeq });
    return true;
  } catch {
    return false;
  }
}
