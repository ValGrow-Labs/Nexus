// Software Development Engineer. B2a: nine of twelve steps run for real,
// triggered by the user: requirements, repository snapshots, tests, builds,
// applications, dev deployments on 127.0.0.1 and diagnostics. B2b: AI-assisted
// implementation, review and iteration (the agent works in a Nexus worktree;
// the user reviews, accepts into refs/nexus/accepted/<branch> and merges). The B2b steps are REAL and delivered
// (CURRENT_SUB_PHASE = DELIVERED_SUB_PHASE = B2b: the scripted end-to-end flows prove the platform's wiring; a real model is
// proven separately), so the statusNote and the step-1 note carry the B2b words.

import type { DomainSpec } from '../domainSpec';

const CONTAINER_RUN = ['docker', 'disk:5GiB'] as const;
/** A change set reaches candidate only when every blocking change-set validator passed (sec.entropy_notes is advisory). */
const CHANGE_SET_VALIDATORS = ['git.diff_nonempty', 'git.paths_in_scope', 'sec.secret_scan', 'cs.tests_pass', 'git.applies_cleanly'];
const AGENT_RUN = ['git', 'docker', 'image:sde-node', 'runtime:agent', 'credential:agent'] as const;
/** Until a real model has been tried on this computer: said wherever agent work is stated as part of this release (easy to remove). */
const AGENT_NEW_NOTE = 'Agent work is new in this release and off by default. It has been checked with a scripted agent, not yet with a real model on this computer.';
const AGENT_SCOPE = 'The agent edits files in a Nexus worktree and runs every command in its own container without network access. '
  + 'Its file tools are kept to the worktree by policy, not by the operating system. ' + AGENT_NEW_NOTE;

export const SDE: DomainSpec = {
  specVersion: 3,
  id: 'sde', label: 'Software Development Engineer', shortLabel: 'SDE',
  description: 'Turn a requirement into tested, built and running code, with every claim backed by commits, test reports, build manifests and health checks.',
  tier: 'first-class', hueSlot: 0, icon: 'sde', order: 1,
  participationFromSubPhase: 'B1',
  statusNote: 'Requirements, repository snapshots, tests, builds, applications, dev deployments and diagnostics run in this release. The agent drafts requirements and implements changes in its own worktree; you review, accept and merge them. ' + AGENT_NEW_NOTE,
  legacyDomainIds: ['software-engineering', 'web-app-dev', 'mobile-dev', 'game-dev', 'embedded-systems', 'robotics-iot', 'blockchain-web3', 'automation-rpa'],
  vocabulary: {
    requirement: { singular: 'Requirement', plural: 'Requirements' },
    repository: { singular: 'Repository snapshot', plural: 'Repository snapshots' },
    git_commit: { singular: 'Commit', plural: 'Commits' },
    change_set: { singular: 'Change', plural: 'Changes' },
    test_suite: { singular: 'Test suite', plural: 'Test suites' },
    build: { singular: 'Build', plural: 'Builds' },
    application: { singular: 'Application', plural: 'Applications' },
    diagnostic_report: { singular: 'Diagnostic report', plural: 'Diagnostic reports' }
  },
  kindsProduced: ['requirement', 'repository', 'git_commit', 'change_set', 'test_suite', 'build', 'application', 'diagnostic_report'],
  kindsAccepted: ['defect', 'test_run', 'release_recommendation', 'quality_report', 'serving_package', 'inference_service', 'evaluation', 'model_export'],
  capabilities: [
    { id: 'code.read' }, { id: 'code.edit', scope: { paths: ['**', '!.git/**'] } }, { id: 'git.commit' }, { id: 'sandbox.exec' },
    { id: 'artifact.read' }, { id: 'artifact.register', scope: { kinds: ['requirement', 'change_set', 'test_suite', 'build', 'application', 'diagnostic_report'] } },
    { id: 'job.request', scope: { recipes: ['sde.test.discover', 'sde.test.node', 'sde.test.pytest', 'sde.build.node', 'sde.build.python', 'sde.app.assemble', 'sde.preview.start', 'sde.diagnose'] } },
    { id: 'handoff.create' }, { id: 'review.request' }, { id: 'approval.request', scope: { recipes: ['sde.deps.node', 'sde.deps.python'] } },
    { id: 'test.run' }, { id: 'build.request' }, { id: 'preview.request' }
  ],
  recipes: ['repo.snapshot', 'sde.deps.node', 'sde.deps.python', 'sde.test.discover', 'sde.test.node', 'sde.test.pytest',
    'sde.build.node', 'sde.build.python', 'sde.app.assemble', 'sde.preview.start', 'sde.diagnose',
    'repo.worktree', 'changeset.collect', 'changeset.merge_check', 'changeset.accept', 'changeset.accept_rollback', 'repo.ff'],
  skills: ['nexus-sde-change', 'nexus-sde-tests-first', 'nexus-sde-requirement-draft', 'nexus-sde-app-manifest'],
  actions: ['sde.requirement.write', 'sde.repository.snapshot', 'sde.deps.install', 'sde.tests.discover', 'sde.tests.run',
    'sde.build.run', 'sde.app.assemble', 'sde.preview.start', 'sde.preview.stop', 'sde.diagnose',
    'sde.agent.turn', 'sde.changeset.review', 'sde.changeset.accept', 'sde.repo.merge'],
  lifecycle: [
    { id: 'requirement', label: 'Requirement', consumes: [], produces: ['requirement'],
      via: [{ userAction: 'sde.requirement.write' }, { skill: 'nexus-sde-requirement-draft' }],
      doneWhen: { kind: 'requirement', statuses: ['candidate', 'active'], validators: ['req.schema'] },
      status: 'REAL', subPhase: 'B2a', prerequisites: [], e2eTestId: 'e2e.sde.requirement',
      scopeNote: 'You write it in Nexus, or the agent drafts it for you to review.' },
    { id: 'project', label: 'Project', consumes: [], produces: [],
      via: [{ platform: 'project.import' }, { platform: 'project.attach' }],
      doneWhen: { record: 'participation' },
      status: 'REAL', subPhase: 'B1', prerequisites: [], e2eTestId: 'e2e.sde.project' },
    { id: 'repository', label: 'Repository', consumes: [], produces: ['repository'],
      via: [{ userAction: 'sde.repository.snapshot' }, { recipe: 'repo.snapshot' }],
      doneWhen: { kind: 'repository', statuses: ['active'], validators: ['git.head_resolves'] },
      status: 'REAL', subPhase: 'B2a', prerequisites: ['git'], e2eTestId: 'e2e.sde.repository' },
    { id: 'code', label: 'Code', consumes: ['repository'], produces: ['git_commit'],
      via: [{ platform: 'user.save_commit' }],
      doneWhen: { kind: 'git_commit', statuses: ['candidate', 'active'], validators: [] },
      status: 'REAL', subPhase: 'B2a', prerequisites: ['git'], e2eTestId: 'e2e.sde.code',
      scopeNote: 'Jobs run on a committed snapshot; uncommitted changes are not included.' },
    { id: 'ai-implementation', label: 'AI-assisted implementation', consumes: ['requirement', 'repository'], produces: ['change_set'],
      via: [{ userAction: 'sde.agent.turn' }, { skill: 'nexus-sde-change' }, { skill: 'nexus-sde-tests-first' }],
      doneWhen: { kind: 'change_set', statuses: ['candidate', 'active'], validators: CHANGE_SET_VALIDATORS },
      status: 'REAL', subPhase: 'B2b', prerequisites: [...AGENT_RUN], e2eTestId: 'e2e.sde.ai-implementation',
      scopeNote: AGENT_SCOPE },
    { id: 'tests', label: 'Tests', consumes: ['repository'], produces: ['test_suite'],
      via: [{ userAction: 'sde.tests.discover' }, { userAction: 'sde.deps.install' }, { userAction: 'sde.tests.run' }],
      doneWhen: { kind: 'test_suite', statuses: ['candidate', 'active'], validators: ['suite.discovered', 'sde.tests_pass'] },
      status: 'REAL', subPhase: 'B2a', prerequisites: ['git', ...CONTAINER_RUN], e2eTestId: 'e2e.sde.tests',
      scopeNote: 'Supported runners: node:test, jest, vitest, mocha and pytest. Tests run on a commit; uncommitted changes are not included.' },
    { id: 'review', label: 'Review', consumes: ['change_set'], produces: [],
      via: [{ userAction: 'sde.changeset.review' }, { userAction: 'sde.changeset.accept' }, { userAction: 'sde.repo.merge' }],
      doneWhen: { record: 'review' },
      status: 'REAL', subPhase: 'B2b', prerequisites: ['git'], e2eTestId: 'e2e.sde.review',
      scopeNote: 'Accepting merges the change into a Nexus ref, never into your branch or files. Merging accepted work is a fast-forward you confirm. ' + AGENT_NEW_NOTE },
    { id: 'build', label: 'Build', consumes: ['repository'], produces: ['build'],
      via: [{ userAction: 'sde.build.run' }],
      doneWhen: { kind: 'build', statuses: ['candidate', 'active'],
        validators: ['build.exit_zero', 'build.manifest_present', 'build.output_hashed', 'blob.integrity'] },
      status: 'REAL', subPhase: 'B2a', prerequisites: ['git', ...CONTAINER_RUN], e2eTestId: 'e2e.sde.build' },
    { id: 'application', label: 'Application', consumes: ['build'], produces: ['application'],
      via: [{ userAction: 'sde.app.assemble' }],
      doneWhen: { kind: 'application', statuses: ['candidate', 'active'], validators: ['app.manifest_schema', 'app.preview_health'] },
      status: 'REAL', subPhase: 'B2a', prerequisites: ['git', 'docker', 'image:nexus-fwd'], e2eTestId: 'e2e.sde.application',
      scopeNote: 'Needs a nexus.app.json in the repository.' },
    { id: 'dev-deployment', label: 'Dev deployment', consumes: ['application'], produces: [],
      via: [{ userAction: 'sde.preview.start' }, { userAction: 'sde.preview.stop' }],
      doneWhen: { record: 'deployment_healthy' },
      status: 'REAL', subPhase: 'B2a', prerequisites: ['docker', 'image:nexus-fwd', 'disk:5GiB'], e2eTestId: 'e2e.sde.dev-deployment',
      scopeNote: 'Local only, served on 127.0.0.1. Remote and multi-service environments are not in this release.' },
    { id: 'diagnostics', label: 'Logs and diagnostics', consumes: ['application'], produces: ['diagnostic_report'],
      via: [{ userAction: 'sde.diagnose' }],
      doneWhen: { kind: 'diagnostic_report', statuses: ['candidate', 'active'], validators: ['diag.schema'] },
      status: 'REAL', subPhase: 'B2a', prerequisites: ['docker'], e2eTestId: 'e2e.sde.diagnostics' },
    { id: 'iteration', label: 'Iteration', consumes: ['change_set', 'diagnostic_report'], produces: ['change_set'],
      via: [{ userAction: 'sde.agent.turn' }, { skill: 'nexus-sde-change' }],
      // A change revised at least once: a second version of a change set that passed every change-set check. One change set is the
      // AI-assisted implementation step, never an iteration (the rail reads this record from the artifact summaries).
      doneWhen: { record: 'iteration' },
      status: 'REAL', subPhase: 'B2b', prerequisites: [...AGENT_RUN], e2eTestId: 'e2e.sde.iteration',
      scopeNote: AGENT_SCOPE }
  ],
  handoffRoutes: [
    { to: 'qa', kinds: ['application', 'build', 'requirement', 'test_suite'], action: 'test', subPhase: 'B2c' },
    { to: 'qa', kinds: ['diagnostic_report'], action: 'inform', subPhase: 'B2c' }
  ],
  completionRules: [{ id: 'sde.end-to-end', label: 'End-to-end flow',
    steps: ['requirement', 'project', 'repository', 'code', 'ai-implementation', 'tests', 'review', 'build', 'application',
      'dev-deployment', 'diagnostics', 'iteration'], subPhase: 'B2b' }],
  modules: [
    { id: 'requirements', label: 'Requirements', kinds: ['requirement'], subPhase: 'B2a' },
    { id: 'repository', label: 'Repository', kinds: ['repository', 'git_commit'], subPhase: 'B2a' },
    { id: 'changes', label: 'Changes', kinds: ['change_set'], subPhase: 'B2b' },
    { id: 'tests', label: 'Tests', kinds: ['test_suite'], subPhase: 'B2a' },
    { id: 'builds', label: 'Builds', kinds: ['build'], subPhase: 'B2a' },
    { id: 'applications', label: 'Applications', kinds: ['application'], subPhase: 'B2a' },
    { id: 'dev-deployments', label: 'Dev deployments', kinds: [], subPhase: 'B2a' },
    { id: 'diagnostics', label: 'Diagnostics', kinds: ['diagnostic_report'], subPhase: 'B2a' },
    { id: 'sessions', label: 'Sessions', kinds: [], subPhase: 'B2b' }
  ]
};
