import React, { useState } from 'react';
import { AGENT_FEATURES, DEMO_AGENT_SESSION } from '../data/agents';

export function AgentsSection() {
  const [activeFeatureIndex, setActiveFeatureIndex] = useState(0);

  return (
    <section id="agents" className="nx-section nx-agents-section">
      <div className="nx-container">
        {/* Section Header */}
        <div className="nx-section-header">
          <div className="nx-section-badge">AI AGENT ORCHESTRATION</div>
          <h2 className="nx-section-title">Your coding agents. Working in one place.</h2>
          <p className="nx-section-desc">
            Nexus does not replace Claude Code, Codex, or your CLI tools. It provides a local multi-agent harness to
            orchestrate them in real terminals with shared project context.
          </p>
        </div>

        <div className="nx-agents-grid">
          {/* Feature Tabs / Cards */}
          <div className="nx-agent-features-list">
            {AGENT_FEATURES.map((feat, idx) => {
              const isSelected = activeFeatureIndex === idx;
              return (
                <div
                  key={feat.title}
                  className={`nx-agent-feat-card ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => setActiveFeatureIndex(idx)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setActiveFeatureIndex(idx); }}
                >
                  <div className="nx-feat-header">
                    <span className="nx-feat-badge">{feat.badge}</span>
                    <span className="nx-feat-tagline">{feat.tagline}</span>
                  </div>
                  <h3 className="nx-feat-title">{feat.title}</h3>
                  <p className="nx-feat-desc">{feat.description}</p>
                </div>
              );
            })}
          </div>

          {/* Authentic Agent Workbench Visual */}
          <div className="nx-agent-workbench-frame">
            <div className="nx-aw-topbar">
              <div className="nx-aw-agent-info">
                <span className="nx-aw-pulse-dot" />
                <span className="nx-aw-lead-title">Lead Agent Coordinator</span>
                <span className="nx-aw-engine">Claude 3.7 Sonnet · Native PTY</span>
              </div>
              <div className="nx-aw-pills">
                <span className="nx-aw-pill">Hive: Active</span>
                <span className="nx-aw-pill">1.5s Local Queue</span>
              </div>
            </div>

            {/* Terminal Screen with Real Pty Output */}
            <div className="nx-aw-pty-screen">
              <div className="nx-pty-header">
                <span className="nx-pty-tab is-active">Terminal 1 (pty: /dev/ttys008)</span>
                <span className="nx-pty-tab">worker-1 (Claude)</span>
                <span className="nx-pty-tab">worker-2 (Codex)</span>
              </div>

              <div className="nx-pty-stream">
                {DEMO_AGENT_SESSION.map((log, i) => (
                  <div key={i} className={`nx-pty-row nx-pty-${log.type}`}>
                    {log.prefix && <span className="nx-pty-prefix">{log.prefix}</span>}
                    <span className="nx-pty-text">{log.text}</span>
                  </div>
                ))}
              </div>

              <div className="nx-pty-footer">
                <div className="nx-pty-worker-status">
                  <span className="nx-w-dot is-online" />
                  <span>worker-1: ready</span>
                  <span className="nx-w-dot is-online" />
                  <span>worker-2: ready</span>
                </div>
                <div className="nx-pty-honesty-note">
                  <span>No simulated web chat · Pure local process execution</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

