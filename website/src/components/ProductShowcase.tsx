import { useState } from 'react';
import { ProvenanceMark } from './ProvenanceMark';

type ShowcaseTab = 'launcher' | 'workbench' | 'intel' | 'review' | 'intent';

export function ProductShowcase() {
  const [activeTab, setActiveTab] = useState<ShowcaseTab>('launcher');
  const [demoQuery, setDemoQuery] = useState('Train a PyTorch model to classify support emails');

  // Realistic keyword detection matching startModel.ts
  const getDetected = (text: string) => {
    const q = text.toLowerCase();
    if (q.includes('train') || q.includes('model') || q.includes('dataset') || q.includes('classify')) {
      return { ws: 'Machine Learning', slot: 1, conf: 'strong match', code: 'ml', matched: ['train', 'model', 'classify'] };
    }
    if (q.includes('torch') || q.includes('deep') || q.includes('checkpoint')) {
      return { ws: 'Deep Learning', slot: 2, conf: 'strong match', code: 'dl', matched: ['torch', 'checkpoint'] };
    }
    if (q.includes('dashboard') || q.includes('sql') || q.includes('query')) {
      return { ws: 'Data Analytics', slot: 3, conf: 'strong match', code: 'data', matched: ['query', 'sql'] };
    }
    if (q.includes('test') || q.includes('qa') || q.includes('playwright')) {
      return { ws: 'Quality Assurance', slot: 5, conf: 'strong match', code: 'qa', matched: ['test', 'qa'] };
    }
    if (q.includes('docker') || q.includes('deploy') || q.includes('pipeline')) {
      return { ws: 'DevOps', slot: 7, conf: 'strong match', code: 'devops', matched: ['docker', 'deploy'] };
    }
    return { ws: 'Software Engineering', slot: 0, conf: 'default', code: 'sde', matched: ['code', 'build'] };
  };

  const detected = getDetected(demoQuery);

  return (
    <section id="product" className="nx-section nx-showcase-section">
      <div className="nx-container">
        {/* Section Header */}
        <div className="nx-section-header">
          <div className="nx-section-badge">PRODUCT CAPABILITIES</div>
          <h2 className="nx-section-title">Everything you need to build, connected.</h2>
          <p className="nx-section-desc">
            Nexus replaces disconnected windows and ad-hoc chat tabs with a unified development environment designed
            for engineers working alongside AI coding agents.
          </p>
        </div>

        {/* Showcase Nav Tabs */}
        <div className="nx-showcase-nav" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'launcher'}
            className={`nx-showcase-nav-btn ${activeTab === 'launcher' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('launcher')}
          >
            <span className="nx-showcase-tab-num">01</span>
            <span className="nx-showcase-tab-title">Intelligent Routing</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'workbench'}
            className={`nx-showcase-nav-btn ${activeTab === 'workbench' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('workbench')}
          >
            <span className="nx-showcase-tab-num">02</span>
            <span className="nx-showcase-tab-title">Multi-Agent Workbench</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'intel'}
            className={`nx-showcase-nav-btn ${activeTab === 'intel' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('intel')}
          >
            <span className="nx-showcase-tab-num">03</span>
            <span className="nx-showcase-tab-title">Project Intelligence</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'review'}
            className={`nx-showcase-nav-btn ${activeTab === 'review' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('review')}
          >
            <span className="nx-showcase-tab-num">04</span>
            <span className="nx-showcase-tab-title">Reviewed Diff</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'intent'}
            className={`nx-showcase-nav-btn ${activeTab === 'intent' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('intent')}
          >
            <span className="nx-showcase-tab-num">05</span>
            <span className="nx-showcase-tab-title">Context Intent Line</span>
          </button>
        </div>

        {/* Showcase Display Body */}
        <div className="nx-showcase-stage">
          {/* View 1: Launcher & Routing */}
          {activeTab === 'launcher' && (
            <div className="nx-stage-card nx-grid-launcher">
              <div className="nx-stage-info">
                <span className="nx-stage-label">ZERO CONFIGURATION DISPATCH</span>
                <h3 className="nx-stage-heading">Describe what you want to build. Nexus routes it.</h3>
                <p className="nx-stage-copy">
                  Type a single sentence. Deterministic clue scoring evaluates your intent against the 8 core disciplines
                  without calling external classification LLMs. Try editing the sentence on the right to see live routing.
                </p>
                <div className="nx-stage-tags">
                  <span className="nx-pill-tag">Keyword Scoring</span>
                  <span className="nx-pill-tag">No Cloud Classifier</span>
                  <span className="nx-pill-tag">Instant Provenance</span>
                </div>
              </div>

              <div className="nx-stage-interactive">
                <div className="nx-launcher-demo-box">
                  <div className="nx-launcher-input-head">
                    <label htmlFor="launcher-query">Describe your task:</label>
                  </div>
                  <textarea
                    id="launcher-query"
                    className="nx-launcher-demo-input"
                    value={demoQuery}
                    rows={2}
                    onChange={(e) => setDemoQuery(e.target.value)}
                  />

                  <div className="nx-detection-verdict">
                    <div className="nx-verdict-header">
                      <ProvenanceMark hueSlot={detected.slot} size={10} />
                      <span className="nx-verdict-title">{detected.ws}</span>
                      <span className="nx-verdict-confidence">{detected.conf}</span>
                    </div>
                    <div className="nx-matched-words">
                      <span className="nx-match-label">Matched cues:</span>
                      {detected.matched.map((m) => (
                        <code key={m} className="nx-cue-chip">{m}</code>
                      ))}
                    </div>
                  </div>

                  <div className="nx-launcher-quick-presets">
                    <span className="nx-presets-label">Examples:</span>
                    <button
                      type="button"
                      className="nx-preset-pill"
                      onClick={() => setDemoQuery('Deploy microservice to Kubernetes cluster with helm')}
                    >
                      DevOps Deploy
                    </button>
                    <button
                      type="button"
                      className="nx-preset-pill"
                      onClick={() => setDemoQuery('Write Playwright e2e tests for checkout flow')}
                    >
                      QA Test Plan
                    </button>
                    <button
                      type="button"
                      className="nx-preset-pill"
                      onClick={() => setDemoQuery('Build responsive dashboard using Tailwind and Chart.js')}
                    >
                      Analytics UI
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* View 2: Multi-Agent Workbench */}
          {activeTab === 'workbench' && (
            <div className="nx-stage-card nx-grid-workbench">
              <div className="nx-stage-info">
                <span className="nx-stage-label">COORDINATION WITHOUT CHAOS</span>
                <h3 className="nx-stage-heading">Real terminals. Real agents. Coordinated locally.</h3>
                <p className="nx-stage-copy">
                  Nexus connects directly to the CLI coding agents you run on your machine (Claude Code, Codex, and
                  others). A local hive facilitates structured task delegation between a lead agent and specialized
                  workers with local delivery every 1.5 seconds.
                </p>
                <div className="nx-stage-tags">
                  <span className="nx-pill-tag">Claude Code Compatible</span>
                  <span className="nx-pill-tag">Codex CLI</span>
                  <span className="nx-pill-tag">1.5s Local Pulse</span>
                </div>
              </div>

              <div className="nx-stage-interactive">
                <div className="nx-stage-console">
                  <div className="nx-console-top">
                    <div className="nx-console-meta">
                      <span className="nx-console-icon">⌘</span>
                      <span>local-hive · 2 workers attached</span>
                    </div>
                    <span className="nx-console-status">1.5s queue pulse active</span>
                  </div>
                  <pre className="nx-console-body">
                    <code>
                      <span className="nx-tok-dim">[10:14:02]</span> <span className="nx-tok-lead">LEAD</span>: Analyzing project tree for dependency graph...{'\n'}
                      <span className="nx-tok-dim">[10:14:03]</span> <span className="nx-tok-lead">LEAD</span>: Decomposing task &quot;Fast vector search implementation&quot; into 2 sub-tasks.{'\n'}
                      <span className="nx-tok-dim">[10:14:04]</span> <span className="nx-tok-worker">WORKER-1</span> (Claude): Writing HNSW index builder in <span className="nx-tok-file">src/indexer.ts</span>{'\n'}
                      <span className="nx-tok-dim">[10:14:06]</span> <span className="nx-tok-worker">WORKER-2</span> (Codex): Building unit benchmark in <span className="nx-tok-file">test/bench.test.ts</span>{'\n'}
                      <span className="nx-tok-dim">[10:14:07]</span> <span className="nx-tok-ok">PASSED</span>: Benchmark verified: 24,000 queries/sec with recall @ 0.98{'\n'}
                      <span className="nx-tok-dim">[10:14:08]</span> <span className="nx-tok-lead">LEAD</span>: Ready for diff review. Working tree staged.
                    </code>
                  </pre>
                </div>
              </div>
            </div>
          )}

          {/* View 3: Project Intelligence */}
          {activeTab === 'intel' && (
            <div className="nx-stage-card nx-grid-intel">
              <div className="nx-stage-info">
                <span className="nx-stage-label">DEEP REPOSITORY SCAN</span>
                <h3 className="nx-stage-heading">Deterministic project health and code intelligence.</h3>
                <p className="nx-stage-copy">
                  When you import a local folder, Nexus scans it deterministically. It identifies programming languages,
                  frameworks, test runners, git commit history, and code symbol graphs. Nothing is estimated or
                  hallucinated.
                </p>
                <div className="nx-stage-tags">
                  <span className="nx-pill-tag">AST Code Graph</span>
                  <span className="nx-pill-tag">JUnit Reports</span>
                  <span className="nx-pill-tag">Deterministic Metrics</span>
                </div>
              </div>

              <div className="nx-stage-interactive">
                <div className="nx-intel-panel">
                  <div className="nx-intel-row-top">
                    <span className="nx-intel-repo-name">repository: api-gateway-core</span>
                    <span className="nx-intel-branch">git: feat/cache-warmup</span>
                  </div>

                  <div className="nx-intel-metrics-strip">
                    <div className="nx-intel-stat">
                      <span className="nx-stat-num">365</span>
                      <span className="nx-stat-label">Unit Tests Passing</span>
                    </div>
                    <div className="nx-intel-stat">
                      <span className="nx-stat-num">0</span>
                      <span className="nx-stat-label">Vulnerabilities</span>
                    </div>
                    <div className="nx-intel-stat">
                      <span className="nx-stat-num">96%</span>
                      <span className="nx-stat-label">Repo Health Score</span>
                    </div>
                  </div>

                  <div className="nx-intel-breakdown">
                    <div className="nx-breakdown-bar">
                      <div className="nx-bar-seg" style={{ width: '75%', backgroundColor: '#818CF8' }} title="TypeScript 75%" />
                      <div className="nx-bar-seg" style={{ width: '15%', backgroundColor: '#34D399' }} title="Node.js 15%" />
                      <div className="nx-bar-seg" style={{ width: '10%', backgroundColor: '#FBBF24' }} title="SQLite 10%" />
                    </div>
                    <div className="nx-breakdown-legend">
                      <span><span className="nx-dot" style={{ backgroundColor: '#818CF8' }} /> TypeScript 75%</span>
                      <span><span className="nx-dot" style={{ backgroundColor: '#34D399' }} /> Node.js 15%</span>
                      <span><span className="nx-dot" style={{ backgroundColor: '#FBBF24' }} /> SQLite 10%</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* View 4: Reviewed Diff */}
          {activeTab === 'review' && (
            <div className="nx-stage-card nx-grid-review">
              <div className="nx-stage-info">
                <span className="nx-stage-label">FULL DEVELOPER CONTROL</span>
                <h3 className="nx-stage-heading">One sentence in. A reviewed diff out.</h3>
                <p className="nx-stage-copy">
                  Autonomous agents should never quietly commit unexpected edits. With Nexus, every file modification
                  is presented in a clear side-by-side or unified diff. You review, reject, or commit every changed line.
                </p>
                <div className="nx-stage-tags">
                  <span className="nx-pill-tag">Line-by-Line Inspection</span>
                  <span className="nx-pill-tag">Git Native</span>
                  <span className="nx-pill-tag">Zero Silent Overwrites</span>
                </div>
              </div>

              <div className="nx-stage-interactive">
                <div className="nx-stage-diff">
                  <div className="nx-diff-head">
                    <span className="nx-file-path">src/services/cache.ts</span>
                    <span className="nx-diff-hunk">@@ -14,6 +14,9 @@</span>
                  </div>
                  <div className="nx-diff-lines">
                    <div className="nx-dline nx-dline-ctx">
                      <span className="nx-ln">14</span>
                      <span className="nx-code">export async function getSession(id: string): Promise&lt;Session | null&gt; &#123;</span>
                    </div>
                    <div className="nx-dline nx-dline-del">
                      <span className="nx-ln">15</span>
                      <span className="nx-code">-  const cached = await redis.get(&apos;session:&apos; + id);</span>
                    </div>
                    <div className="nx-dline nx-dline-add">
                      <span className="nx-ln">15</span>
                      <span className="nx-code">+  const key = `session:${'${id}'}`;</span>
                    </div>
                    <div className="nx-dline nx-dline-add">
                      <span className="nx-ln">16</span>
                      <span className="nx-code">+  const cached = await redis.get(key);</span>
                    </div>
                    <div className="nx-dline nx-dline-add">
                      <span className="nx-ln">17</span>
                      <span className="nx-code">+  if (cached) await redis.expire(key, 86400); // sliding TTL renewal</span>
                    </div>
                    <div className="nx-dline nx-dline-ctx">
                      <span className="nx-ln">18</span>
                      <span className="nx-code">   return cached ? JSON.parse(cached) : null;</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* View 5: Context Intent Line */}
          {activeTab === 'intent' && (
            <div className="nx-stage-card nx-grid-intent">
              <div className="nx-stage-info">
                <span className="nx-stage-label">PRECISION SELECTION CONTEXT</span>
                <h3 className="nx-stage-heading">A single intent line, bound to your selection.</h3>
                <p className="nx-stage-copy">
                  Summoned via <kbd>⌘J</kbd> or docked in workspace and project pages. The intent line automatically
                  embeds the active project, dirty git state, and workspace provenance chip so you never re-type context.
                </p>
                <div className="nx-stage-tags">
                  <span className="nx-pill-tag">⌘J / Ctrl+J Docked</span>
                  <span className="nx-pill-tag">Context Chips</span>
                  <span className="nx-pill-tag">No Hallucinated Routing</span>
                </div>
              </div>

              <div className="nx-stage-interactive">
                <div className="nx-intent-visual-box">
                  <div className="nx-intent-chip-preview">
                    <ProvenanceMark hueSlot={0} size={8} />
                    <span className="nx-chip-ws">SDE</span>
                    <span className="nx-chip-divider">/</span>
                    <span className="nx-chip-project">api-gateway-core</span>
                    <span className="nx-chip-status">3 modified files</span>
                  </div>

                  <div className="nx-intent-bar-mock">
                    <span className="nx-intent-cursor">&gt;</span>
                    <span className="nx-intent-typed">Add rate-limiting middleware using token bucket algorithm</span>
                    <button type="button" className="nx-intent-run-btn">
                      <span>Send</span>
                      <kbd>↵</kbd>
                    </button>
                  </div>

                  <div className="nx-intent-annotations">
                    <span>Context automatically bound to prompt:</span>
                    <code>&#123; workspaceId: &quot;sde&quot;, projectId: &quot;proj-01&quot;, branch: &quot;main&quot;, dirtyCount: 3 &#125;</code>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
