import { TELEMETRY_ALLOWLIST, TELEMETRY_EVENTS } from '../data/telemetry';

export function LocalFirstSection() {
  return (
    <section id="local-first" className="nx-section nx-local-first-section">
      <div className="nx-container">
        {/* Section Header */}
        <div className="nx-section-header">
          <div className="nx-section-badge">LOCAL-FIRST ARCHITECTURE</div>
          <h2 className="nx-section-title">Your projects. Your machine. Your workflow.</h2>
          <p className="nx-section-desc">
            Nexus runs directly on your local hardware. Your code stays in your filesystem, SQLite databases remain on
            your machine, and all terminal processes execute locally.
          </p>
        </div>

        {/* 3 Pillars of Local First */}
        <div className="nx-local-pillars">
          <div className="nx-pillar-card">
            <div className="nx-pillar-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
                <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                <line x1="6" y1="6" x2="6.01" y2="6"></line>
                <line x1="6" y1="18" x2="6.01" y2="18"></line>
              </svg>
            </div>
            <h3 className="nx-pillar-title">On-Device SQLite Engine</h3>
            <p className="nx-pillar-text">
              Project indexes, agent run states, and workspace associations are persisted to an embedded SQLite database
              in your user data directory with full WAL mode concurrency.
            </p>
          </div>

          <div className="nx-pillar-card">
            <div className="nx-pillar-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 17l6-6-6-6"></path>
                <path d="M12 19h8"></path>
              </svg>
            </div>
            <h3 className="nx-pillar-title">Direct Subprocess Execution</h3>
            <p className="nx-pillar-text">
              Coding agents and tool executions spawn as local operating system processes via native pseudo-terminals.
              No proprietary cloud harness sits between you and your binaries.
            </p>
          </div>

          <div className="nx-pillar-card">
            <div className="nx-pillar-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
            </div>
            <h3 className="nx-pillar-title">No Code Uploads</h3>
            <p className="nx-pillar-text">
              Your source files, repositories, AST graphs, and git logs are read from disk and never uploaded to any
              Nexus backend servers.
            </p>
          </div>
        </div>

        {/* Telemetry Contract Transparency Block */}
        <div className="nx-telemetry-contract">
          <div className="nx-telemetry-head">
            <div className="nx-telemetry-title-row">
              <span className="nx-telemetry-badge">TELEMETRY CONTRACT</span>
              <h3 className="nx-telemetry-heading">Complete transparency on anonymous telemetry.</h3>
            </div>
            <p className="nx-telemetry-intro">
              Nexus collects a small set of anonymous usage events so we can understand adoption and fix crashes. This is
              our strict contract—enforced as a hard allowlist in open-source code:
            </p>
          </div>

          <div className="nx-telemetry-grid">
            {TELEMETRY_ALLOWLIST.map((entry) => (
              <div key={entry.category} className={`nx-telemetry-box nx-telemetry-${entry.status}`}>
                <span className="nx-box-title">{entry.category}</span>
                <ul className="nx-box-list">
                  {entry.items.map((it) => (
                    <li key={it}>{it}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="nx-telemetry-events-table">
            <span className="nx-events-table-title">Exact Anonymous Events Emitted:</span>
            <div className="nx-table-wrap">
              <table className="nx-data-table">
                <thead>
                  <tr>
                    <th>Event Name</th>
                    <th>Properties</th>
                    <th>Trigger Condition</th>
                  </tr>
                </thead>
                <tbody>
                  {TELEMETRY_EVENTS.map((e) => (
                    <tr key={e.event}>
                      <td><code>{e.event}</code></td>
                      <td><code>{e.payload}</code></td>
                      <td>{e.when}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="nx-telemetry-optout">
            <span className="nx-optout-label">100% Opt-Out Guaranteed:</span>
            <span className="nx-optout-text">
              Disable anytime in <strong>Settings → Anonymous usage stats</strong>, or set the standard{' '}
              <code>DO_NOT_TRACK=1</code> environment variable. Local source builds compile with telemetry completely disabled.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

