import { useState } from 'react';
import { GITHUB_REPO_URL } from '../data/navigation';
import { ProvenanceMark } from './ProvenanceMark';

type HeroTab = 'workbench' | 'diff' | 'intelligence';

export function Hero() {
  const [activeTab, setActiveTab] = useState<HeroTab>('workbench');
  const [intentInput, setIntentInput] = useState('Refactor sqlite connection pool to support WAL mode');

  return (
    <section className="nx-hero-section">
      <div className="nx-container">
        {/* Editorial Hero Header */}
        <div className="nx-hero-header">
          <div className="nx-hero-eyebrow">
            <span className="nx-eyebrow-dot" />
            <span>INTRODUCING NEXUS · AI-NATIVE DEVELOPMENT</span>
          </div>

          <h1 className="nx-hero-title">
            Your entire development world.
            <br />
            <span className="nx-hero-title-accent">One workspace.</span>
          </h1>

          <p className="nx-hero-desc">
            Bring your projects, AI coding agents and everyday developer tools together. Nexus gives you a focused
            environment to build, organise and move faster.
          </p>

          <div className="nx-hero-cta-group">
            <a href="#product" className="nx-btn-hero-primary">
              Explore Nexus
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="5" y1="12" x2="19" y2="12"></line>
                <polyline points="12 5 19 12 12 19"></polyline>
              </svg>
            </a>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="nx-btn-hero-secondary"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
              <span>View on GitHub</span>
            </a>
          </div>

          <div className="nx-hero-note">
            <span className="nx-note-tag">Phase A Beta</span>
            <span className="nx-note-text">Local-first desktop application · Runs on macOS, Linux, and Windows</span>
          </div>
        </div>

        {/* Visual Centrepiece: Authentic Desktop Application Window */}
        <div className="nx-hero-preview-frame">
          <div className="nx-window-bezel">
            {/* Window Titlebar */}
            <div className="nx-window-header">
              <div className="nx-window-controls" aria-hidden="true">
                <span className="nx-window-dot nx-dot-close" />
                <span className="nx-window-dot nx-dot-min" />
                <span className="nx-window-dot nx-dot-max" />
              </div>

              {/* Nexus Context Bar */}
              <div className="nx-mock-bar">
                <div className="nx-mock-brand">
                  <span>Nexus</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                </div>
                <div className="nx-mock-breadcrumbs">
                  <span className="nx-mock-sep">/</span>
                  <span className="nx-mock-ws-crumb">
                    <ProvenanceMark hueSlot={0} size={8} />
                    <span>SDE</span>
                  </span>
                  <span className="nx-mock-sep">/</span>
                  <span className="nx-mock-proj-crumb">nexus-platform</span>
                </div>
              </div>

              {/* Status & Search */}
              <div className="nx-mock-actions">
                <div className="nx-mock-runs-pill">
                  <span className="nx-runs-live-indicator" />
                  <span>2 agents active</span>
                </div>
                <div className="nx-mock-search-btn">
                  <span>Search</span>
                  <kbd>⌘K</kbd>
                </div>
              </div>
            </div>

            {/* Application Main Layout */}
            <div className="nx-window-body">
              {/* Left Spine */}
              <aside className="nx-mock-spine" aria-label="Project Spine">
                <div className="nx-mock-spine-head">
                  <span className="nx-spine-section-title">THE SPINE</span>
                  <span className="nx-spine-badge">Real State</span>
                </div>

                <div className="nx-mock-spine-group">
                  <div className="nx-mock-group-title">
                    <ProvenanceMark hueSlot={0} size={8} />
                    <span>Software Engineering</span>
                  </div>

                  <div className="nx-mock-spine-node is-active">
                    <div className="nx-node-line">
                      <span className="nx-node-icon">⌥</span>
                      <span className="nx-node-label">source: git</span>
                    </div>
                    <span className="nx-node-meta">branch: main [7f3b8a1]</span>
                  </div>

                  <div className="nx-mock-spine-node">
                    <div className="nx-node-line">
                      <span className="nx-node-icon">Δ</span>
                      <span className="nx-node-label">changes</span>
                    </div>
                    <span className="nx-node-meta">3 files modified (+42, -8)</span>
                  </div>

                  <div className="nx-mock-spine-node is-planned">
                    <div className="nx-node-line">
                      <span className="nx-node-icon">⚑</span>
                      <span className="nx-node-label">artifacts</span>
                    </div>
                    <span className="nx-node-meta">Phase A · Planned</span>
                  </div>
                </div>

                <div className="nx-mock-spine-footer">
                  <span className="nx-spine-foot-tag">repo health: 96/100</span>
                </div>
              </aside>

              {/* Main Focus Surface */}
              <main className="nx-mock-focus-surface">
                {/* Surface Mode Selector */}
                <div className="nx-surface-tab-bar">
                  <button
                    type="button"
                    className={`nx-surface-tab ${activeTab === 'workbench' ? 'is-active' : ''}`}
                    onClick={() => setActiveTab('workbench')}
                  >
                    <span className="nx-tab-indicator" />
                    <span>Agent Workbench</span>
                    <span className="nx-tab-badge">2 active</span>
                  </button>
                  <button
                    type="button"
                    className={`nx-surface-tab ${activeTab === 'diff' ? 'is-active' : ''}`}
                    onClick={() => setActiveTab('diff')}
                  >
                    <span>Reviewed Diff</span>
                    <span className="nx-tab-badge">3 files</span>
                  </button>
                  <button
                    type="button"
                    className={`nx-surface-tab ${activeTab === 'intelligence' ? 'is-active' : ''}`}
                    onClick={() => setActiveTab('intelligence')}
                  >
                    <span>Project Intelligence</span>
                    <span className="nx-tab-badge">Health 96%</span>
                  </button>
                </div>

                {/* Tab 1: Agent Workbench */}
                {activeTab === 'workbench' && (
                  <div className="nx-mock-workbench-view">
                    <div className="nx-wb-agent-header">
                      <div className="nx-agent-avatar">
                        <span className="nx-avatar-core">LA</span>
                      </div>
                      <div className="nx-agent-identity">
                        <div className="nx-agent-title-row">
                          <span className="nx-agent-role">Lead Agent</span>
                          <span className="nx-agent-engine">Claude 3.7 Sonnet (CLI)</span>
                        </div>
                        <span className="nx-agent-goal">Orchestrating SQLite WAL refactoring & unit verification</span>
                      </div>
                      <div className="nx-agent-status-tag">
                        <span className="nx-status-led" />
                        <span>Hive Active</span>
                      </div>
                    </div>

                    <div className="nx-wb-terminal-screen">
                      <div className="nx-term-line nx-term-prompt">$ nexus intent --workspace sde --project nexus-platform</div>
                      <div className="nx-term-line nx-term-dim">[context] branch: main · uncommitted: 0 · engine: claude-code-pty</div>
                      <div className="nx-term-line nx-term-info">→ Lead agent parsed instruction: &quot;Refactor sqlite connection pool to support WAL mode&quot;</div>
                      <div className="nx-term-line nx-term-agent">  [task #104] assigned to worker-sde-1: &quot;Update db.ts with PRAGMA journal_mode = WAL;&quot;</div>
                      <div className="nx-term-line nx-term-agent">  [task #105] assigned to worker-qa-1: &quot;Run concurrency suite across 8 worker threads&quot;</div>
                      <div className="nx-term-line nx-term-code">  + db.pragma(&apos;journal_mode = WAL&apos;);</div>
                      <div className="nx-term-line nx-term-code">  + db.pragma(&apos;synchronous = NORMAL&apos;);</div>
                      <div className="nx-term-line nx-term-success">✔ worker-qa-1: 365 tests passed in 3.44s. Zero locking contentions detected.</div>
                      <div className="nx-term-line nx-term-warn">! Generated diff ready for developer inspection in Reviewed Diff tab.</div>
                    </div>
                  </div>
                )}

                {/* Tab 2: Reviewed Diff */}
                {activeTab === 'diff' && (
                  <div className="nx-mock-diff-view">
                    <div className="nx-diff-banner">
                      <span className="nx-diff-file-title">src/main/db.ts</span>
                      <span className="nx-diff-stats">+18 -4 lines</span>
                    </div>
                    <div className="nx-diff-code-table">
                      <div className="nx-diff-row nx-diff-ctx">
                        <span className="nx-line-no">24</span>
                        <span className="nx-line-content">export function openDatabase(dbPath: string): Database &#123;</span>
                      </div>
                      <div className="nx-diff-row nx-diff-del">
                        <span className="nx-line-no">25</span>
                        <span className="nx-line-content">-   const db = new Database(dbPath);</span>
                      </div>
                      <div className="nx-diff-row nx-diff-add">
                        <span className="nx-line-no">25</span>
                        <span className="nx-line-content">+   const db = new Database(dbPath, &#123; timeout: 5000 &#125;);</span>
                      </div>
                      <div className="nx-diff-row nx-diff-add">
                        <span className="nx-line-no">26</span>
                        <span className="nx-line-content">+   db.pragma(&apos;journal_mode = WAL&apos;);</span>
                      </div>
                      <div className="nx-diff-row nx-diff-add">
                        <span className="nx-line-no">27</span>
                        <span className="nx-line-content">+   db.pragma(&apos;busy_timeout = 5000&apos;);</span>
                      </div>
                      <div className="nx-diff-row nx-diff-ctx">
                        <span className="nx-line-no">28</span>
                        <span className="nx-line-content">    return db;</span>
                      </div>
                      <div className="nx-diff-row nx-diff-ctx">
                        <span className="nx-line-no">29</span>
                        <span className="nx-line-content">&#125;</span>
                      </div>
                    </div>
                    <div className="nx-diff-actions-strip">
                      <span className="nx-diff-summary">Human-in-the-loop review: line changes verified against tests</span>
                      <button type="button" className="nx-btn-diff-accept">Review Hunk</button>
                    </div>
                  </div>
                )}

                {/* Tab 3: Project Intelligence */}
                {activeTab === 'intelligence' && (
                  <div className="nx-mock-intel-view">
                    <div className="nx-intel-grid">
                      <div className="nx-intel-card">
                        <span className="nx-intel-metric-label">Languages Detected</span>
                        <div className="nx-lang-bars">
                          <div className="nx-lang-item">
                            <span className="nx-lang-name">TypeScript</span>
                            <span className="nx-lang-pct">84.2%</span>
                          </div>
                          <div className="nx-lang-item">
                            <span className="nx-lang-name">Node.js / CJS</span>
                            <span className="nx-lang-pct">11.6%</span>
                          </div>
                          <div className="nx-lang-item">
                            <span className="nx-lang-name">CSS / OKLCH</span>
                            <span className="nx-lang-pct">4.2%</span>
                          </div>
                        </div>
                      </div>

                      <div className="nx-intel-card">
                        <span className="nx-intel-metric-label">Deterministic Analysis</span>
                        <ul className="nx-intel-list">
                          <li>✔ Git repository verified (branch clean)</li>
                          <li>✔ 365 / 365 tests passing across suites</li>
                          <li>✔ SQLite schema migration validated (WAL mode)</li>
                          <li>✔ 0 unassigned external dependencies</li>
                        </ul>
                      </div>
                    </div>

                    <div className="nx-health-bar-container">
                      <div className="nx-health-label-row">
                        <span>Repository Health Score</span>
                        <span className="nx-health-score">96 / 100 · Optimal</span>
                      </div>
                      <div className="nx-health-track">
                        <div className="nx-health-fill" style={{ width: '96%' }} />
                      </div>
                    </div>
                  </div>
                )}

                {/* Docked Intent Line (⌘J) */}
                <div className="nx-mock-intent-dock">
                  <div className="nx-intent-chip">
                    <ProvenanceMark hueSlot={0} size={6} />
                    <span className="nx-intent-ws">sde</span>
                    <span className="nx-intent-sep">/</span>
                    <span className="nx-intent-proj">nexus-platform</span>
                    <kbd className="nx-intent-shortcut">⌘J</kbd>
                  </div>
                  <input
                    type="text"
                    className="nx-intent-input"
                    value={intentInput}
                    onChange={(e) => setIntentInput(e.target.value)}
                    placeholder="Ask lead agent with current project context..."
                  />
                  <button type="button" className="nx-intent-send" aria-label="Send intent to lead agent">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="22" y1="2" x2="11" y2="13"></line>
                      <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                    </svg>
                  </button>
                </div>
              </main>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

