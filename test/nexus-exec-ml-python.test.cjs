'use strict';
// The machine learning kit (ml-python) on REAL Docker, behind the test:exec resource gate (node tools/run-exec-tests.cjs); anywhere else
// it prints the skip banner.
// - XM1: the kit is built through the real image builder path (RunnerCore image.build.start: the context copied and hashed, compared
//   with lock.json, `docker build` with the Nexus labels), then a small ML job runs in it as a real "Try it" plan from main's own plan
//   builder, with the network OFF and the AI helper's limits (1 CPU, 1024 MB, 512 processes, a 512 MB /tmp): pandas reads a generated
//   10,000-row CSV staged from a committed repository, a RandomForest is trained, the model is saved with joblib and a PNG chart is
//   written headless. The outputs are read back and checked on the host.
// - XM2: an agent turn of a Machine learning project (the real runner core, the real Docker driver, ScriptedRuntime for the model): the
//   helper's own container is the ML kit and `python -c "import pandas, sklearn, matplotlib"` works through the helper's real
//   sandbox_exec path.
// - XM3: a Machine learning project's data (phase 2): a CSV the person added through main's DatasetService is read by the helper's own
//   container at /data/x.csv with pandas, and the folder is READ-ONLY there (writing, appending and deleting all fail; the copy is
//   unchanged on the host), with the network off.
// - XM4: a Machine learning project's results (phase 3): the helper's own container writes a report, a matplotlib (Agg) PNG chart, a
//   joblib model and a predictions CSV to /results; the host folder results/<project>/files gets them and main's ResultsService lists,
//   shows and saves them; /data is still read-only; the network is off; the project's files are not touched (the turn changes nothing).
//   Adversarial files written from inside (a symbolic link, a hard-linked pair, a folder, a fake PNG, an HTML page, a control character
//   and a Windows device name in a name) are never listed or read.
// Each test removes the containers, volumes and networks it made (by this run's nexus.home label) and its temp folders. The built
// image nexus-local/ml-python:<context12> is KEPT: it is the kit the app uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const { realDockerOrSkip } = require('./helpers/execGate.cjs');

if (realDockerOrSkip()) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const h = require('./helpers/sqlite.cjs');
  const loadTs = require('./load-ts.cjs');
  const { runnerHarness, labelled, docker, LOCK } = require('./helpers/execReal.cjs');
  const { buildPlan } = loadTs('src/main/nexus/exec/planBuilder.ts');
  const { getRecipe } = loadTs('src/shared/nexus/recipes.ts');
  const { newId } = loadTs('src/main/nexus/db/ids.ts');
  const LONG = { timeout: 25 * 60_000 };
  const MIN = 60_000;
  const ML = LOCK.profiles['ml-python'];
  const AGENT_LIMITS = { cpus: 1, memoryMb: 1024, pids: 512, tmpfsMb: 512 };

  /** A deterministic 10,000-row CSV: 8 numeric columns, one category, a label that depends on three of them (plus noise). */
  function trainCsv(rows = 10_000) {
    let s = 20261101;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const lines = ['f0,f1,f2,f3,f4,f5,f6,f7,segment,label'];
    for (let i = 0; i < rows; i++) {
      const f = Array.from({ length: 8 }, () => rnd() * 2 - 1);
      const seg = ['north', 'south', 'east', 'west'][Math.floor(rnd() * 4)];
      const score = f[0] + 0.5 * f[1] - f[2] + (seg === 'north' ? 0.3 : 0) + (rnd() - 0.5) * 0.4;
      lines.push(`${f.map((x) => x.toFixed(5)).join(',')},${seg},${score > 0 ? 1 : 0}`);
    }
    return `${lines.join('\n')}\n`;
  }
  const ML_JOB = `import json, os, socket, sys, time
t0 = time.time()
import numpy as np, pandas as pd, sklearn, joblib, matplotlib
import matplotlib.pyplot as plt
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
m = {"python": sys.version.split()[0], "uid": os.getuid(), "backend": matplotlib.get_backend().lower(), "mplconfigdir": os.environ.get("MPLCONFIGDIR"),
     "versions": {"numpy": np.__version__, "pandas": pd.__version__, "sklearn": sklearn.__version__, "matplotlib": matplotlib.__version__, "joblib": joblib.__version__}}
try:
    socket.create_connection(("pypi.org", 443), timeout=3)
    m["network"] = "reachable"
except Exception as e:
    m["network"] = "off (" + type(e).__name__ + ")"
df = pd.read_csv("data/train.csv")
m["rows"], m["cols"] = int(df.shape[0]), int(df.shape[1])
X = pd.get_dummies(df.drop(columns=["label"]), columns=["segment"])
y = df["label"]
Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=0)
clf = RandomForestClassifier(n_estimators=60, max_depth=10, n_jobs=-1, random_state=0).fit(Xtr, ytr)
m["accuracy"] = round(float(clf.score(Xte, yte)), 4)
joblib.dump(clf, "/out/model.joblib", compress=3)
m["reload_ok"] = bool(joblib.load("/out/model.joblib").score(Xte, yte) == clf.score(Xte, yte))
imp = pd.Series(clf.feature_importances_, index=X.columns).sort_values()
fig, ax = plt.subplots(figsize=(6, 4))
imp.plot.barh(ax=ax)
ax.set_title("Feature importance")
fig.tight_layout()
fig.savefig("/out/chart.png", dpi=100)
def rd(p):
    try:
        return open(p).read().strip()
    except Exception:
        return None
m["cpu_max"], m["memory_max"], m["pids_max"] = rd("/sys/fs/cgroup/cpu.max"), rd("/sys/fs/cgroup/memory.max"), rd("/sys/fs/cgroup/pids.max")
m["seconds"] = round(time.time() - t0, 2)
json.dump(m, open("/out/metrics.json", "w"))
print("ML-JOB " + json.dumps(m))
`;
  /** A committed repository holding the dataset and the job: what the sandbox sees of a project is its committed files. */
  function mlRepo() {
    const dir = h.tmpDir('nx-ml-repo-');
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'train.csv'), trainCsv());
    fs.writeFileSync(path.join(dir, 'ml_job.py'), ML_JOB);
    const git = (...a) => execFileSync('git', ['-c', 'user.name=Nexus Test', '-c', 'user.email=test@nexus.invalid', '-c', 'core.autocrlf=false', ...a],
      { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
    git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'dataset and job');
    return { dir, commit: git('rev-parse', 'HEAD') };
  }

  test('XM1 the ML kit, built through the real image builder, runs a 10,000-row pandas / RandomForest / joblib / headless-PNG job with the network off and the helper\'s limits', LONG, async () => {
    const hs = await runnerHarness();
    try {
      // 1. Build through the runner's image builder (the app's path; the approval id is the test's own).
      const buildId = newId(Date.now());
      const started = Date.now();
      hs.send({ op: 'image.build.start', buildId, profile: 'ml-python', approvalId: 'test/nexus-exec-ml-python', contextSha256: ML.contextSha256 });
      await hs.until(() => hs.got.some((m) => m.op === 'image.build.done' && m.buildId === buildId), 'the ML kit build', 20 * MIN);
      const done = hs.got.find((m) => m.op === 'image.build.done' && m.buildId === buildId);
      assert.equal(done.outcome, 'succeeded', done.error);
      assert.match(done.imageId, /^sha256:[0-9a-f]{64}$/);
      console.log(`# XM1 build ${((Date.now() - started) / 1000).toFixed(1)} s (cached layers count), ${(done.sizeBytes / 2 ** 20).toFixed(0)} MiB reported`);
      const labels = JSON.parse(docker(['image', 'inspect', done.imageId, '--format', '{{json .Config.Labels}}']).stdout);
      assert.equal(labels['nexus.profile'], 'ml-python');
      assert.equal(labels['nexus.context-sha256'], ML.contextSha256);
      assert.equal(labels['nexus.versions'], Object.entries(ML.versions).map(([k, v]) => `${k}=${v}`).join(' '), 'the label the build self-test checked');
      // 2. The probe sees it as the ML kit's image.
      const before = hs.got.filter((m) => m.op === 'probe.result').length;
      hs.send({ op: 'probe' });
      await hs.until(() => hs.got.filter((m) => m.op === 'probe.result').length > before, 'a fresh probe');
      const probe = hs.got.filter((m) => m.op === 'probe.result').pop();
      const img = probe.images.find((i) => i.profile === 'ml-python');
      assert.deepEqual([img.present, img.digestMatches, img.imageId, img.contextSha256], [true, true, done.imageId, ML.contextSha256]);
      // 3. A "Try it" run of the committed job, planned by main's plan builder in the ML kit, with the helper's limits.
      const repo = mlRepo();
      const profile = hs.images.profiles.find((p) => p.id === 'ml-python');
      const jobId = newId(Date.now()); const attemptId = newId(Date.now());
      const plan = buildPlan({ job: { id: jobId, projectId: 'p-exec-ml' }, attempt: { id: attemptId, n: 1 }, bootId: hs.bootId, recipe: getRecipe('sde.try.run'), profile,
        imageId: done.imageId, dataHomeRoot: hs.root, workRel: `work/${jobId}/1`, logRel: `logs/jobs/${jobId}/1.log`, repoPath: repo.dir,
        inputs: [{ versionId: 'V', slot: 'change', contentHash: 'x', storage: { kind: 'git', commit: repo.commit }, metadata: {} }], params: { argv: ['python', 'ml_job.py'] } });
      assert.deepEqual(plan.container.network, { mode: 'none' }, 'no network');
      assert.equal(plan.container.env.PYTHONPATH, undefined);
      assert.equal(plan.staging.depsVolume, undefined, 'no dependency volume: the packages are in the image');
      Object.assign(plan.container.limits, AGENT_LIMITS);
      hs.start(plan);
      const prov = await hs.provisioned(plan, 5 * MIN);
      assert.equal(prov.preflight.ok, true, JSON.stringify(prov.preflight.problems));
      assert.equal(prov.preflight.observed.nanoCpus, 1e9);
      assert.equal(prov.preflight.observed.memory, 1024 * 2 ** 20);
      assert.equal(prov.preflight.observed.pidsLimit, 512);
      assert.equal(prov.preflight.observed.networkMode, 'none');
      const exited = await hs.exited(plan, 10 * MIN);
      const out = hs.output(plan);
      assert.ok(exited, `the job exited (${hs.of('fault', plan.attemptId).map((f) => JSON.stringify(f)).join(' ')})`);
      assert.equal(exited.exit.code, 0, out.slice(-3000));
      assert.equal(exited.exit.oomKilled, false);
      // 4. The outputs, read back on the host.
      const outDir = path.join(plan.workDir, 'out');
      const m = JSON.parse(fs.readFileSync(path.join(outDir, 'metrics.json'), 'utf8'));
      console.log(`# XM1 job ${JSON.stringify(m)}`);
      assert.match(out, /^ML-JOB \{/m);
      assert.deepEqual([m.rows, m.cols], [10_000, 10]);
      assert.ok(m.accuracy >= 0.85, `accuracy ${m.accuracy}`);
      assert.equal(m.reload_ok, true, 'the saved model loads back and scores the same');
      assert.match(m.network, /^off \(/, 'the network is off inside the run');
      assert.equal(m.backend, 'agg', 'charts are drawn headless');
      assert.equal(m.mplconfigdir, '/tmp/matplotlib');
      assert.equal(m.uid, 10001);
      assert.equal(m.python, ML.versions.python);
      assert.deepEqual([m.versions.numpy, m.versions.pandas, m.versions.sklearn, m.versions.matplotlib, m.versions.joblib],
        [ML.versions.numpy, ML.versions.pandas, ML.versions['scikit-learn'], ML.versions.matplotlib, ML.versions.joblib]);
      assert.deepEqual([m.cpu_max, m.memory_max, m.pids_max], ['100000 100000', String(1024 * 2 ** 20), '512'], 'the helper\'s limits inside the container');
      const model = fs.readFileSync(path.join(outDir, 'model.joblib'));
      assert.ok(model.length > 10_000, `model ${model.length} bytes`);
      const png = fs.readFileSync(path.join(outDir, 'chart.png'));
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG file');
      assert.ok(png.length > 5_000, `chart ${png.length} bytes`);
      assert.deepEqual(exited.outputs.map((o) => o.relPath).sort(), ['chart.png', 'metrics.json', 'model.joblib']);
      hs.release(plan);
      await hs.until(() => labelled(hs.home, { 'nexus.attempt': plan.attemptId }).containers.length === 0, 'the run\'s container is removed', 2 * MIN);
    } finally {
      await hs.close();
      const left = labelled(hs.home);
      assert.deepEqual([left.containers.length, left.volumes.length, left.networks.length], [0, 0, 0], 'nothing of this run is left in Docker');
    }
  });

  test('XM2 an ML project\'s AI helper: its sandbox_exec container is the ML kit and python -c "import pandas, sklearn, matplotlib" works there', LONG, async () => {
    const { flowWorld, useFixture, sound } = require('./helpers/agentFlowWorld.cjs');
    const { homeLabel } = loadTs('src/shared/nexus/homeLabel.ts');
    const w = await flowWorld({ real: true });
    const home = homeLabel(w.dataHome.root);
    try {
      await useFixture(w, 'pytest-app');
      // The project's primary kind of work becomes Machine learning (its primary participation is the `ml` workspace).
      w.db.transaction(() => {
        w.db.prepare('UPDATE project_workspaces SET is_primary = 0 WHERE project_id = ? AND is_primary = 1').run(w.PROJECT);
        const row = w.db.prepare("SELECT id FROM project_workspaces WHERE project_id = ? AND workspace_id = 'ml'").get(w.PROJECT);
        if (row) w.db.prepare("UPDATE project_workspaces SET status = 'active', is_primary = 1 WHERE id = ?").run(row.id);
        else w.db.prepare(`INSERT INTO project_workspaces (id, project_id, workspace_id, objective, status, is_primary, source, created_by, created_at, updated_at)
          VALUES ('pw-ml-xm2', ?, 'ml', NULL, 'active', 1, 'user', 'user:local', ?, ?)`).run(w.PROJECT, Date.now(), Date.now());
      })();
      await w.snapshot();
      await w.consent();
      // The ML kit must be usable for the turn to lease (XM1 builds it; the probe reads it).
      await w.until(() => (w.nx.exec.health().images.find((i) => i.profile === 'ml-python') ?? {}).matches === true, 'the ML kit is seen by the probe', 3 * MIN);
      w.script(() => [{ op: 'call', tool: 'sandbox_exec', args: { argv: ['python', '-c', 'import pandas, sklearn, matplotlib; print("ml-ok", pandas.__version__, sklearn.__version__, matplotlib.get_backend())'],
        cwd: '/workspace', timeoutMs: 5 * MIN } }, { op: 'complete' }]);
      const r = await w.turn('Check the machine learning packages', { ms: 15 * MIN });
      const at = w.db.prepare('SELECT state, environment_json, sandbox_json FROM job_attempts WHERE job_id = ? ORDER BY n DESC').get(r.jobId);
      const env = JSON.parse(at.environment_json);
      const sb = JSON.parse(at.sandbox_json);
      const mlImage = w.nx.exec.health().images.find((i) => i.profile === 'ml-python').imageId;
      assert.equal(env.profile, 'ml-python', 'the helper\'s container is the ML kit');
      assert.equal(env.imageId, mlImage);
      assert.equal(sb.network.mode, 'none');
      const ex = w.execResults(r.jobId);
      assert.equal(ex.length, 1, JSON.stringify(ex));
      assert.equal(ex[0].exit, 0, JSON.stringify(ex[0]));
      assert.match(ex[0].stdout, new RegExp(`^ml-ok ${ML.versions.pandas.replace(/\./g, '\\.')} ${ML.versions['scikit-learn'].replace(/\./g, '\\.')} agg`, 'mi'));
      // The turn changed no file: it ends as every such turn does (the attempt succeeded, the job is partial with no change).
      assert.deepEqual([r.job.state, r.job.outcome], ['partial', 'no_change'], `${r.job.state} ${r.job.error_json}`);
      assert.equal(at.state, 'succeeded');
      sound(w, 'XM2');
    } finally {
      try { await w.close(); } catch { /* best effort */ }
      const left = labelled(home);
      assert.deepEqual([left.containers.length, left.volumes.length, left.networks.length], [0, 0, 0], 'nothing of this world is left in Docker');
    }
  });

  test('XM3 an ML project\'s data: the helper\'s container reads /data/x.csv with pandas and cannot write, append or delete there; network off', LONG, async () => {
    const { flowWorld, useFixture, sound } = require('./helpers/agentFlowWorld.cjs');
    const { homeLabel } = loadTs('src/shared/nexus/homeLabel.ts');
    const crypto = require('node:crypto');
    const w = await flowWorld({ real: true });
    const home = homeLabel(w.dataHome.root);
    try {
      await useFixture(w, 'pytest-app');
      w.db.transaction(() => {
        w.db.prepare('UPDATE project_workspaces SET is_primary = 0 WHERE project_id = ? AND is_primary = 1').run(w.PROJECT);
        const row = w.db.prepare("SELECT id FROM project_workspaces WHERE project_id = ? AND workspace_id = 'ml'").get(w.PROJECT);
        if (row) w.db.prepare("UPDATE project_workspaces SET status = 'active', is_primary = 1 WHERE id = ?").run(row.id);
        else w.db.prepare(`INSERT INTO project_workspaces (id, project_id, workspace_id, objective, status, is_primary, source, created_by, created_at, updated_at)
          VALUES ('pw-ml-xm3', ?, 'ml', NULL, 'active', 1, 'user', 'user:local', ?, ?)`).run(w.PROJECT, Date.now(), Date.now());
      })();
      // The person adds a dataset (main's window faked at its port: the location it would answer).
      const src = h.tmpDir('nx-ml-data-');
      const csv = path.join(src, 'x.csv');
      fs.writeFileSync(csv, trainCsv(500));
      const me = w.nx.principals.localUser();
      const added = await w.nx.datasets.add(me, w.PROJECT, async () => csv);
      assert.equal(added.added.file, 'x.csv');
      const copy = path.join(w.dataHome.root, 'datasets', w.PROJECT, 'files', 'x.csv');
      const hashOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      const before = hashOf(copy);
      await w.snapshot();
      await w.consent();
      await w.until(() => (w.nx.exec.health().images.find((i) => i.profile === 'ml-python') ?? {}).matches === true, 'the ML kit is seen by the probe', 3 * MIN);
      const job = [
        'import json, os, socket',
        'import pandas as pd',
        'r = {}',
        'df = pd.read_csv("/data/x.csv")',
        'r["shape"] = [int(df.shape[0]), int(df.shape[1])]',
        'r["first"] = list(df.columns)[:3]',
        'def attempt(name, fn):',
        '    try:',
        '        fn()',
        '        r[name] = "done"',
        '    except Exception as e:',
        '        r[name] = "refused " + type(e).__name__ + " " + str(getattr(e, "errno", ""))',
        'attempt("write", lambda: open("/data/new.txt", "w").write("x"))',
        'attempt("append", lambda: open("/data/x.csv", "a").write("9"))',
        'attempt("delete", lambda: os.remove("/data/x.csv"))',
        'attempt("mkdir", lambda: os.mkdir("/data/sub"))',
        'attempt("network", lambda: socket.create_connection(("pypi.org", 443), timeout=3))',
        'r["listing"] = sorted(os.listdir("/data"))',
        'print("DATA-JOB " + json.dumps(r))'
      ].join('\n');
      w.script(() => [{ op: 'call', tool: 'sandbox_exec', args: { argv: ['python', '-c', job], cwd: '/workspace', timeoutMs: 5 * MIN } }, { op: 'complete' }]);
      const r = await w.turn('Profile my data', { ms: 15 * MIN });
      const at = w.db.prepare('SELECT state, environment_json, sandbox_json FROM job_attempts WHERE job_id = ? ORDER BY n DESC').get(r.jobId);
      const env = JSON.parse(at.environment_json);
      const sb = JSON.parse(at.sandbox_json);
      assert.equal(env.profile, 'ml-python', 'the helper\'s container is the ML kit');
      assert.equal(sb.network.mode, 'none');
      assert.deepEqual(sb.mounts.filter((m) => m.containerPath === '/data'), [{ kind: 'datasets', containerPath: '/data', readOnly: true }], 'exactly one read-only /data mount, recorded without a host path');
      const ex = w.execResults(r.jobId);
      assert.equal(ex.length, 1, JSON.stringify(ex));
      assert.equal(ex[0].exit, 0, JSON.stringify(ex[0]));
      const line = ex[0].stdout.split('\n').find((l) => l.startsWith('DATA-JOB '));
      assert.ok(line, ex[0].stdout);
      const got = JSON.parse(line.slice('DATA-JOB '.length));
      console.log(`# XM3 ${JSON.stringify(got)}`);
      assert.deepEqual(got.shape, [500, 10], 'pandas read the whole file');
      assert.deepEqual(got.first, ['f0', 'f1', 'f2']);
      for (const k of ['write', 'append', 'delete', 'mkdir']) assert.match(got[k], /^refused (OSError|PermissionError) 30$/, `${k}: read-only file system (EROFS): ${got[k]}`);
      assert.match(got.network, /^refused /, 'no network');
      assert.deepEqual(got.listing, ['x.csv'], 'only the project\'s own data, nothing written there');
      assert.equal(hashOf(copy), before, 'Nexus\'s copy is unchanged on the host');
      assert.equal(hashOf(csv), before, 'the person\'s original is unchanged');
      assert.equal(at.state, 'succeeded');
      sound(w, 'XM3');
    } finally {
      try { await w.close(); } catch { /* best effort */ }
      const left = labelled(home);
      assert.deepEqual([left.containers.length, left.volumes.length, left.networks.length], [0, 0, 0], 'nothing of this world is left in Docker');
    }
  });

  test('XM4 an ML project\'s results: the helper\'s container writes a report, a chart, a model and predictions to /results; main lists, shows and saves them; /data read-only; nothing else touched', LONG, async () => {
    const { flowWorld, useFixture, sound } = require('./helpers/agentFlowWorld.cjs');
    const { homeLabel } = loadTs('src/shared/nexus/homeLabel.ts');
    const { resultIdOf } = loadTs('src/main/nexus/results/resultsService.ts');
    const crypto = require('node:crypto');
    const w = await flowWorld({ real: true });
    const home = homeLabel(w.dataHome.root);
    try {
      await useFixture(w, 'pytest-app');
      w.db.transaction(() => {
        w.db.prepare('UPDATE project_workspaces SET is_primary = 0 WHERE project_id = ? AND is_primary = 1').run(w.PROJECT);
        const row = w.db.prepare("SELECT id FROM project_workspaces WHERE project_id = ? AND workspace_id = 'ml'").get(w.PROJECT);
        if (row) w.db.prepare("UPDATE project_workspaces SET status = 'active', is_primary = 1 WHERE id = ?").run(row.id);
        else w.db.prepare(`INSERT INTO project_workspaces (id, project_id, workspace_id, objective, status, is_primary, source, created_by, created_at, updated_at)
          VALUES ('pw-ml-xm4', ?, 'ml', NULL, 'active', 1, 'user', 'user:local', ?, ?)`).run(w.PROJECT, Date.now(), Date.now());
      })();
      const src = h.tmpDir('nx-ml-res-');
      const csv = path.join(src, 'x.csv');
      fs.writeFileSync(csv, trainCsv(800));
      const me = w.nx.principals.localUser();
      await w.nx.datasets.add(me, w.PROJECT, async () => csv);
      const dataCopy = path.join(w.dataHome.root, 'datasets', w.PROJECT, 'files', 'x.csv');
      const hashOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      const dataBefore = hashOf(dataCopy);
      await w.snapshot();
      await w.consent();
      await w.until(() => (w.nx.exec.health().images.find((i) => i.profile === 'ml-python') ?? {}).matches === true, 'the ML kit is seen by the probe', 3 * MIN);
      const job = [
        'import json, os, socket',
        'import matplotlib',
        'matplotlib.use("Agg")',
        'import matplotlib.pyplot as plt',
        'import pandas as pd, joblib',
        'from sklearn.linear_model import LogisticRegression',
        'from sklearn.model_selection import train_test_split',
        'r = {}',
        'def attempt(name, fn):',
        '    try:',
        '        fn()',
        '        r[name] = "done"',
        '    except Exception as e:',
        '        r[name] = "refused " + type(e).__name__ + " " + str(getattr(e, "errno", ""))',
        'df = pd.read_csv("/data/x.csv")',
        'X = pd.get_dummies(df.drop(columns=["label"]), columns=["segment"])',
        'y = df["label"]',
        'Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.25, random_state=42)',
        'm = LogisticRegression(max_iter=500, random_state=42).fit(Xtr, ytr)',
        'acc = round(float(m.score(Xte, yte)), 4)',
        'r["accuracy"] = acc',
        'open("/results/report.md", "w").write("# Who leaves\\n\\nAccuracy on the held-out quarter: **" + str(acc) + "**\\n\\n<script>alert(1)</script>\\n")',
        'fig, ax = plt.subplots(figsize=(5, 3))',
        'df["label"].value_counts().plot.bar(ax=ax)',
        'fig.tight_layout()',
        'fig.savefig("/results/chart.png", dpi=80)',
        'joblib.dump(m, "/results/model.joblib", compress=3)',
        'pd.DataFrame({"p": m.predict_proba(Xte)[:, 1]}).to_csv("/results/predictions.csv", index=False)',
        '# Adversarial files the listing must leave out (an attempt may fail on some file systems: that is fine).',
        'open("/results/fake.png", "w").write("<svg onload=alert(1)>")',
        'open("/results/page.html", "w").write("<script>alert(1)</script>")',
        'attempt("symlink", lambda: os.symlink("/etc/passwd", "/results/link.md"))',
        'open("/results/hl_src.md", "w").write("twice")',
        'attempt("hardlink", lambda: os.link("/results/hl_src.md", "/results/hl.md"))',
        'attempt("folder", lambda: (os.mkdir("/results/sub"), open("/results/sub/inner.md", "w").write("x")))',
        'attempt("control", lambda: open("/results/a" + chr(1) + "b.md", "w").write("x"))',
        'attempt("device", lambda: open("/results/CON.png", "w").write("x"))',
        'attempt("data_write", lambda: open("/data/new.txt", "w").write("x"))',
        'attempt("network", lambda: socket.create_connection(("pypi.org", 443), timeout=3))',
        'r["listing"] = sorted(os.listdir("/results"))',
        'print("RESULTS-JOB " + json.dumps(r))'
      ].join('\n');
      w.script(() => [{ op: 'call', tool: 'sandbox_exec', args: { argv: ['python', '-c', job], cwd: '/workspace', timeoutMs: 5 * MIN } }, { op: 'complete' }]);
      const r = await w.turn('Which customers are likely to leave?', { ms: 15 * MIN });
      const at = w.db.prepare('SELECT state, environment_json, sandbox_json FROM job_attempts WHERE job_id = ? ORDER BY n DESC').get(r.jobId);
      const env = JSON.parse(at.environment_json);
      const sb = JSON.parse(at.sandbox_json);
      assert.equal(env.profile, 'ml-python');
      assert.equal(sb.network.mode, 'none');
      assert.deepEqual(sb.mounts.filter((m) => m.containerPath === '/results' || m.containerPath === '/data'),
        [{ kind: 'datasets', containerPath: '/data', readOnly: true }, { kind: 'results', containerPath: '/results', readOnly: false }], 'the record names no host path');
      const ex = w.execResults(r.jobId);
      assert.equal(ex.length, 1, JSON.stringify(ex));
      assert.equal(ex[0].exit, 0, JSON.stringify(ex[0]));
      const line = ex[0].stdout.split('\n').find((l) => l.startsWith('RESULTS-JOB '));
      assert.ok(line, ex[0].stdout);
      const got = JSON.parse(line.slice('RESULTS-JOB '.length));
      console.log(`# XM4 ${JSON.stringify(got)}`);
      assert.ok(got.accuracy >= 0.7, `accuracy ${got.accuracy}`);
      assert.match(got.data_write, /^refused (OSError|PermissionError) 30$/, '/data is still read-only (EROFS)');
      assert.match(got.network, /^refused /, 'no network');
      for (const n of ['report.md', 'chart.png', 'model.joblib', 'predictions.csv']) assert.ok(got.listing.includes(n), `${n} written in the container`);
      // The host folder holds them.
      const dir = path.join(w.dataHome.root, 'results', w.PROJECT, 'files');
      const png = fs.readFileSync(path.join(dir, 'chart.png'));
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a real PNG on the host');
      assert.ok(fs.statSync(path.join(dir, 'model.joblib')).size > 200);
      assert.match(fs.readFileSync(path.join(dir, 'predictions.csv'), 'utf8'), /^p\r?\n0\./);
      // Main lists them (the adversarial files left out), shows the report and the chart, and saves the model.
      const l = await w.nx.results.list(me, w.PROJECT);
      const names = l.results.map((x) => x.name).sort();
      assert.deepEqual(names, ['chart.png', 'fake.png', 'model.joblib', 'predictions.csv', 'report.md'], JSON.stringify(l));
      const kinds = Object.fromEntries(l.results.map((x) => [x.name, [x.kind, x.shown]]));
      assert.deepEqual(kinds, { 'chart.png': ['chart', true], 'fake.png': ['file', false], 'model.joblib': ['model', false], 'predictions.csv': ['table', false], 'report.md': ['report', true] });
      assert.ok(l.skipped >= 2, `left out: page.html and the hard-linked pair at least, then whatever else the file system let the container make (${l.skipped})`);
      const rep = await w.nx.results.read(me, w.PROJECT, resultIdOf('report.md'));
      assert.ok(rep.text.includes(`Accuracy on the held-out quarter: **${got.accuracy}**`), rep.text);
      assert.ok(rep.text.includes('<script>alert(1)</script>'), 'kept as letters, shown as text');
      const chart = await w.nx.results.read(me, w.PROJECT, resultIdOf('chart.png'));
      assert.deepEqual(Buffer.from(chart.dataUrl.slice('data:image/png;base64,'.length), 'base64'), png);
      const out = h.tmpDir('nx-ml-save-');
      const dest = path.join(out, 'churn.joblib');
      assert.deepEqual(await w.nx.results.save(me, w.PROJECT, resultIdOf('model.joblib'), async () => dest), { saved: true, name: 'model.joblib' });
      assert.equal(hashOf(dest), hashOf(path.join(dir, 'model.joblib')), 'the saved model is byte for byte');
      for (const n of ['page.html', 'link.md', 'hl.md', `a${String.fromCharCode(1)}b.md`, 'CON.png', 'inner.md']) {
        await assert.rejects(w.nx.results.read(me, w.PROJECT, resultIdOf(n)), (e) => e.detail?.reason === 'results_not_found', n);
      }
      // Nothing else touched: the data copy, and the project's files (the turn changed no file).
      assert.equal(hashOf(dataCopy), dataBefore, 'Nexus\'s data copy is unchanged');
      assert.deepEqual([r.job.state, r.job.outcome], ['partial', 'no_change'], `the project's files are not touched: ${r.job.state} ${r.job.error_json}`);
      const sess = w.db.prepare('SELECT session_id FROM jobs WHERE id = ?').get(r.jobId).session_id;
      const wt = path.join(w.dataHome.root, 'wt', String(sess).toLowerCase());
      if (fs.existsSync(wt)) {
        const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: wt, encoding: 'utf8', windowsHide: true }).trim();
        assert.equal(status, '', 'the worktree holds no output');
      }
      assert.equal(at.state, 'succeeded');
      sound(w, 'XM4');
    } finally {
      try { await w.close(); } catch { /* best effort */ }
      const left = labelled(home);
      assert.deepEqual([left.containers.length, left.volumes.length, left.networks.length], [0, 0, 0], 'nothing of this world is left in Docker');
    }
  });
}
