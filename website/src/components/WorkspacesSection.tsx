import { useState } from 'react';
import { WORKSPACES, type WorkspaceItem } from '../data/workspaces';
import { Emblem } from './Emblem';
import { ProvenanceMark, provenanceStyle } from './ProvenanceMark';

export function WorkspacesSection() {
  const [selectedWs, setSelectedWs] = useState<WorkspaceItem>(WORKSPACES[0]);

  return (
    <section id="workspaces" className="nx-section nx-workspaces-section">
      <div className="nx-container">
        {/* Section Header */}
        <div className="nx-section-header">
          <div className="nx-section-badge">INTELLIGENT WORKSPACES</div>
          <h2 className="nx-section-title">Every discipline deserves its own workspace.</h2>
          <p className="nx-section-desc">
            Nexus organizes projects according to development domains. Each workspace features a permanent mathematical
            provenance hue and procedural vector emblem.
          </p>
        </div>

        {/* Golden-Angle Provenance Formula Explainer */}
        <div className="nx-provenance-explainer">
          <div className="nx-formula-badge">THE SLOT RULE</div>
          <code className="nx-formula-code">
            provenanceHue(slot) = round(((265 + slot × 137.508) mod 360) × 10) / 10
          </code>
          <p className="nx-formula-desc">
            Color means provenance, not decorative styling. Workspaces walk the golden angle from base hue 265°, ensuring
            colors never shift when new domains are added.
          </p>
        </div>

        {/* Sophisticated Interactive Arrangement */}
        <div className="nx-ws-interactive-layout">
          {/* Workspaces List / Selector */}
          <div className="nx-ws-list" role="tablist" aria-label="Workspaces">
            {WORKSPACES.map((ws) => {
              const isSelected = selectedWs.id === ws.id;
              const provStyle = provenanceStyle(ws.hueSlot);

              return (
                <button
                  key={ws.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className={`nx-ws-row-item ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => setSelectedWs(ws)}
                  style={provStyle}
                >
                  <div className="nx-ws-row-left">
                    <ProvenanceMark hueSlot={ws.hueSlot} size={10} />
                    <span className="nx-ws-row-label">{ws.label}</span>
                    <span className="nx-ws-row-name">{ws.name}</span>
                  </div>

                  <div className="nx-ws-row-right">
                    <span className="nx-ws-row-hue">{ws.hue}°</span>
                    <span className="nx-ws-row-tagline">{ws.tagline}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Active Workspace Deep Dive Panel */}
          <div className="nx-ws-detail-card" style={provenanceStyle(selectedWs.hueSlot)}>
            <div className="nx-ws-detail-header">
              <div className="nx-ws-detail-emblem-wrap">
                <Emblem id={selectedWs.id} size={56} />
              </div>
              <div className="nx-ws-detail-title-block">
                <div className="nx-ws-code-slot">
                  <span className="nx-ws-code">{selectedWs.label}</span>
                  <span className="nx-ws-slot-pill">Slot {selectedWs.hueSlot} · {selectedWs.hue}° hue</span>
                </div>
                <h3 className="nx-ws-fullname">{selectedWs.name}</h3>
                <span className="nx-ws-detail-tagline">{selectedWs.tagline}</span>
              </div>
            </div>

            <p className="nx-ws-detail-desc">{selectedWs.description}</p>

            {/* Mapped Domains */}
            <div className="nx-ws-meta-block">
              <span className="nx-ws-meta-heading">Detected Engineering Domains:</span>
              <div className="nx-ws-domain-chips">
                {selectedWs.domains.map((d) => (
                  <span key={d} className="nx-domain-chip">{d}</span>
                ))}
              </div>
            </div>

            {/* Planned Modules */}
            <div className="nx-ws-meta-block">
              <span className="nx-ws-meta-heading">Planned Domain Modules (Phase A Roadmap):</span>
              <div className="nx-ws-planned-chips">
                {selectedWs.plannedModules.map((m) => (
                  <span key={m} className="nx-planned-chip">
                    <span className="nx-planned-dot" />
                    <span>{m}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* Sample CLI Invocations */}
            <div className="nx-ws-terminal-preview">
              <span className="nx-ws-cli-title">Sample Workflow:</span>
              {selectedWs.sampleCommands.map((cmd) => (
                <div key={cmd} className="nx-ws-cli-row">
                  <span className="nx-cli-prompt">$</span>
                  <code className="nx-cli-cmd">{cmd}</code>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

