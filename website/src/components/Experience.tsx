import React from 'react';
import { ProvenanceMark } from './ProvenanceMark';

export function Experience() {
  return (
    <section id="experience" className="nx-section nx-experience-section">
      <div className="nx-container">
        {/* Section Header */}
        <div className="nx-section-header">
          <div className="nx-section-badge">THE NEXUS EXPERIENCE</div>
          <h2 className="nx-section-title">From scattered tools to a connected workflow.</h2>
          <p className="nx-section-desc">
            A cohesive four-step development lifecycle engineered for clarity, speed, and uncompromising software quality.
          </p>
        </div>

        {/* 4 Distinct Alternating Stories */}
        <div className="nx-experience-stories">
          {/* Story 01: Choose your workspace */}
          <div className="nx-story-row nx-story-alt-1">
            <div className="nx-story-content">
              <span className="nx-story-step">EXPERIENCE 01</span>
              <h3 className="nx-story-title">Choose your workspace.</h3>
              <p className="nx-story-body">
                Rather than treating all coding tasks as identical text editing, Nexus provides dedicated workspaces
                tailored to specific engineering domains: Software Engineering, Machine Learning, Deep Learning,
                Data Analytics, Research, QA, UI/UX, and DevOps.
              </p>
              <ul className="nx-story-highlights">
                <li>Permanent mathematical provenance hues for every domain</li>
                <li>Tailored toolbars, planned modules, and project filtering</li>
                <li>Zero cognitive clutter across unrelated engineering disciplines</li>
              </ul>
            </div>

            <div className="nx-story-visual nx-visual-workspaces">
              <div className="nx-visual-ws-strip">
                <div className="nx-ws-preview-pill">
                  <ProvenanceMark hueSlot={0} size={10} />
                  <span className="nx-ws-pill-name">SDE</span>
                  <span className="nx-ws-pill-tag">Code · APIs</span>
                </div>
                <div className="nx-ws-preview-pill">
                  <ProvenanceMark hueSlot={1} size={10} />
                  <span className="nx-ws-pill-name">ML</span>
                  <span className="nx-ws-pill-tag">Models · Datasets</span>
                </div>
                <div className="nx-ws-preview-pill">
                  <ProvenanceMark hueSlot={2} size={10} />
                  <span className="nx-ws-pill-name">DL</span>
                  <span className="nx-ws-pill-tag">Checkpoints</span>
                </div>
                <div className="nx-ws-preview-pill">
                  <ProvenanceMark hueSlot={3} size={10} />
                  <span className="nx-ws-pill-name">Data</span>
                  <span className="nx-ws-pill-tag">Dashboards</span>
                </div>
              </div>
              <div className="nx-visual-caption">8 dedicated disciplines with permanent golden-angle hue distribution</div>
            </div>
          </div>

          {/* Story 02: Bring your projects */}
          <div className="nx-story-row nx-story-alt-2">
            <div className="nx-story-visual nx-visual-import">
              <div className="nx-import-terminal-card">
                <div className="nx-card-header">
                  <span className="nx-card-dot" />
                  <span>Deterministic Repository Scanner</span>
                </div>
                <div className="nx-import-log">
                  <div className="nx-log-entry">$ nexus import ~/Developer/inference-server</div>
                  <div className="nx-log-ok">✔ Project root verified: 142 source files</div>
                  <div className="nx-log-info">→ Detected frameworks: Fastify, TypeScript, Vitest</div>
                  <div className="nx-log-info">→ Git repository clean: branch &apos;main&apos; (ahead 0, behind 0)</div>
                  <div className="nx-log-ok">✔ Filed under workspace: Software Engineering (SDE)</div>
                  <div className="nx-log-score">Repo Health Score: 98/100</div>
                </div>
              </div>
            </div>

            <div className="nx-story-content">
              <span className="nx-story-step">EXPERIENCE 02</span>
              <h3 className="nx-story-title">Bring your projects.</h3>
              <p className="nx-story-body">
                Point Nexus to any local folder on your computer. Nexus analyses your project deterministically—extracting
                languages, dependencies, test setups, git state, and a code symbol graph.
              </p>
              <ul className="nx-story-highlights">
                <li>Automatic classification into the corresponding domain workspace</li>
                <li>Comprehensive repository health score with actionable insights</li>
                <li>100% on-device deterministic inspection with zero cloud upload</li>
              </ul>
            </div>
          </div>

          {/* Story 03: Work alongside AI agents */}
          <div className="nx-story-row nx-story-alt-1">
            <div className="nx-story-content">
              <span className="nx-story-step">EXPERIENCE 03</span>
              <h3 className="nx-story-title">Work alongside AI agents.</h3>
              <p className="nx-story-body">
                Coordinate CLI coding agents like Claude Code, Codex, and terminal tools in a local hive. A lead agent
                breaks requests into atomic tasks, dispatches them to worker agents, and delivers messages via a local
                1.5-second queue pulse.
              </p>
              <ul className="nx-story-highlights">
                <li>Real pseudo-terminals (pty) executing native developer CLIs</li>
                <li>Autonomous sub-task allocation with full live log visibility</li>
                <li>Zero cloud relay—all agent orchestration remains on your machine</li>
              </ul>
            </div>

            <div className="nx-story-visual nx-visual-agents">
              <div className="nx-hive-orchestrator-card">
                <div className="nx-hive-flow">
                  <div className="nx-hive-node nx-node-lead">
                    <span className="nx-node-badge">Lead Agent</span>
                    <span className="nx-node-desc">Plan &amp; Decompose</span>
                  </div>
                  <div className="nx-hive-pulse-arrow">
                    <span className="nx-pulse-line" />
                    <span className="nx-pulse-label">1.5s queue</span>
                  </div>
                  <div className="nx-hive-workers">
                    <div className="nx-worker-chip">
                      <span className="nx-chip-dot" />
                      <span>worker-1: Code Edit</span>
                    </div>
                    <div className="nx-worker-chip">
                      <span className="nx-chip-dot" />
                      <span>worker-2: Unit Tests</span>
                    </div>
                  </div>
                </div>
                <div className="nx-hive-footer">
                  <span>Engine: Claude Code CLI + Codex Subprocesses</span>
                </div>
              </div>
            </div>
          </div>

          {/* Story 04: Stay in control */}
          <div className="nx-story-row nx-story-alt-2">
            <div className="nx-story-visual nx-visual-control">
              <div className="nx-diff-review-mockup">
                <div className="nx-diff-mock-head">
                  <span>Reviewed Diff: git status clean verification</span>
                  <span className="nx-diff-badge-ok">All Tests Passing</span>
                </div>
                <div className="nx-diff-mock-table">
                  <div className="nx-diff-mline nx-mline-del">
                    <code>- function handleToken(t) &#123; return decode(t); &#125;</code>
                  </div>
                  <div className="nx-diff-mline nx-mline-add">
                    <code>+ function handleToken(t) &#123; verifySignature(t); return decode(t); &#125;</code>
                  </div>
                </div>
                <div className="nx-diff-mock-btn-row">
                  <span className="nx-diff-hint">You decide what gets committed.</span>
                  <div className="nx-btn-mini-group">
                    <span className="nx-btn-mini-discard">Discard</span>
                    <span className="nx-btn-mini-approve">Approve Hunk</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="nx-story-content">
              <span className="nx-story-step">EXPERIENCE 04</span>
              <h3 className="nx-story-title">Stay in control of your development.</h3>
              <p className="nx-story-body">
                Nexus is grounded in engineering honesty: &ldquo;Unavailable is stated, never faked.&rdquo; You review
                every changed line in git before code is accepted. Actions the app cannot perform are never rendered as
                misleading buttons.
              </p>
              <ul className="nx-story-highlights">
                <li>Line-by-line before/after diff review on every agent modification</li>
                <li>Transparent status reporting: no hallucinated approvals or metrics</li>
                <li>Built from real state only: empty states say so plainly</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

