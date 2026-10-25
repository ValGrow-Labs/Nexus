/**
 * The authorization policy: a pure function from (principal, roles, action) to a
 * decision. No I/O; AuthService resolves the principal and its roles from the DB.
 *
 * Decision order (first match wins):
 *   1. unknown principal         -> 'unknown_principal'
 *   2. disabled principal        -> 'disabled_principal'
 *   3. agent principal           -> 'agent_requires_token' (agents act only through
 *                                   capability tokens, which arrive in a later phase)
 *   4. system-only action        -> allowed only for kind 'system', else 'system_only'
 *   5. user-only action (B2b)    -> refused for kind 'system' with 'user_only' (agents stopped at 3)
 *   6. no role in scope          -> 'no_membership'
 *   7. strongest role (max ROLE_RANK across all matching scopes) must cover the
 *      action's minimum role     -> else 'role' with `needed`.
 *
 * Max-role semantics: a broad grant (for example a platform owner) is not narrowed
 * by a weaker, narrower row. Multi-user can add explicit deny rows later without
 * changing the scope model.
 */
import type { AuthDecision, PlatformAction, Principal, Role } from '../../../shared/nexus/platform';
import type { CapabilityId } from '../../../shared/nexus/domainSpec';

export const ROLE_RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

export const READ_ACTIONS: readonly PlatformAction[] = Object.freeze([
  'project.read', 'workspace.read', 'artifact.read', 'lineage.read', 'job.read', 'session.read', 'activity.read',
  'handoff.read', 'approval.read', 'platform.health'
] as PlatformAction[]);

export const MEMBER_ACTIONS: readonly PlatformAction[] = Object.freeze([
  'participation.attach', 'participation.withdraw', 'artifact.create',
  'version.register', 'version.update_draft', 'version.discard', 'version.promote',
  'lineage.write', 'job.create', 'job.cancel', 'session.open', 'session.cancel',
  'handoff.send', 'handoff.respond', 'handoff.withdraw', 'deployment.stop', 'version.revalidate',
  // B2b: start an agent turn; a user's review decision and change-set accept (USER_ONLY_ACTIONS: never the system).
  'agent.start', 'review.decide', 'changeset.accept'
] as PlatformAction[]);

// blob.gc: apply a blob GC (B2a, A6) at platform scope; the local owner and the system principal (admin) may.
export const ADMIN_ACTIONS: readonly PlatformAction[] = Object.freeze(['artifact.archive', 'blob.gc'] as PlatformAction[]);

// approval.respond: a user's once-only consent (egress, image preparation). Owner today; admin for those in multi-user later.
// B2b: repo.merge (the dialog-confirmed fast-forward into the user's branch) and agent.consent (the runtime's network
// permission and caps) are the owner's.
export const OWNER_ACTIONS: readonly PlatformAction[] = Object.freeze(['approval.respond', 'repo.merge', 'agent.consent'] as PlatformAction[]);

// approval.create, deployment.transition and exec.ingest: written by the execution core as the system principal only.
export const SYSTEM_ONLY_ACTIONS: readonly PlatformAction[] = Object.freeze([
  'version.finalize', 'job.transition', 'session.transition', 'system.reconcile',
  'approval.create', 'deployment.transition', 'exec.ingest',
  // B2b: capability tokens are minted by the execution core in the lease transaction.
  'token.mint'
] as PlatformAction[]);

/** B2b: actions a stored user takes in person. Classified by role above as well; the system principal is refused. */
export const USER_ONLY_ACTIONS: readonly PlatformAction[] = Object.freeze(['review.decide', 'changeset.accept'] as PlatformAction[]);

const MIN_ROLE = new Map<PlatformAction, Role>([
  ...READ_ACTIONS.map((a) => [a, 'viewer'] as const),
  ...MEMBER_ACTIONS.map((a) => [a, 'member'] as const),
  ...ADMIN_ACTIONS.map((a) => [a, 'admin'] as const),
  ...OWNER_ACTIONS.map((a) => [a, 'owner'] as const)
]);
const SYSTEM_ONLY = new Set<PlatformAction>(SYSTEM_ONLY_ACTIONS);
const USER_ONLY = new Set<PlatformAction>(USER_ONLY_ACTIONS);

export function decide(i: { principal: Principal | null; disabled?: boolean; roles: Role[]; action: PlatformAction }): AuthDecision {
  const p = i.principal;
  if (!p) return { allowed: false, reason: 'unknown_principal' };
  if (i.disabled) return { allowed: false, reason: 'disabled_principal' };
  if (p.kind === 'agent') return { allowed: false, reason: 'agent_requires_token' };
  if (p.kind !== 'user' && p.kind !== 'system') return { allowed: false, reason: 'unknown_principal' };
  if (SYSTEM_ONLY.has(i.action)) return p.kind === 'system' ? { allowed: true, role: 'system' } : { allowed: false, reason: 'system_only' };
  if (USER_ONLY.has(i.action) && p.kind !== 'user') return { allowed: false, reason: 'user_only' };
  let best: Role | null = null;
  for (const r of i.roles) if (ROLE_RANK[r] && (best === null || ROLE_RANK[r] > ROLE_RANK[best])) best = r;
  if (best === null) return { allowed: false, reason: 'no_membership' };
  // An action missing from every list (impossible while the lists cover PlatformAction) needs owner: fail closed.
  const needed = MIN_ROLE.get(i.action) ?? 'owner';
  return ROLE_RANK[best] >= ROLE_RANK[needed] ? { allowed: true, role: best } : { allowed: false, reason: 'role', needed };
}

// ---------- B2b: what an agent's capability token may be used for (AuthService.authorizeWithToken) ----------

/**
 * The only actions an agent may take, each with the capabilities that cover it (any one, inside the token's grant and
 * the domain's ceiling). Every other action is refused for agents (`agent_forbidden`): they never promote, discard,
 * accept, merge, decide a review, answer an approval, grant consent, archive, cancel or mint.
 */
export const AGENT_ACTION_CAPABILITIES: Readonly<Partial<Record<PlatformAction, readonly CapabilityId[]>>> = Object.freeze({
  'project.read': Object.freeze(['artifact.read']),
  'workspace.read': Object.freeze(['artifact.read']),
  'artifact.read': Object.freeze(['artifact.read']),
  'lineage.read': Object.freeze(['artifact.read']),
  'job.read': Object.freeze(['artifact.read']),
  'session.read': Object.freeze(['artifact.read']),
  'artifact.create': Object.freeze(['artifact.register']),
  'version.register': Object.freeze(['artifact.register']),
  'version.update_draft': Object.freeze(['artifact.register']),
  // A recipe job: one of the domain's own recipes, or an egress recipe the agent may only ask approval for.
  'job.create': Object.freeze(['job.request', 'approval.request'])
} as Partial<Record<PlatformAction, readonly CapabilityId[]>>);

/** The action each MCP tool is authorized as; a call naming another action for the tool is refused. */
export const TOOL_ACTIONS: Readonly<Record<string, PlatformAction>> = Object.freeze({
  context_get: 'artifact.read', artifact_list: 'artifact.read', artifact_read: 'artifact.read', validations_get: 'artifact.read',
  job_status: 'job.read', job_logs: 'job.read',
  sandbox_exec: 'job.create', job_request: 'job.create',
  changeset_register: 'version.register', requirement_draft: 'version.register', review_request: 'version.register'
} as Record<string, PlatformAction>);

/** True when an agent may take `action` at all (with a token whose grant covers it). */
export function agentMayTake(action: PlatformAction): boolean {
  return Object.prototype.hasOwnProperty.call(AGENT_ACTION_CAPABILITIES, action);
}
