export function DeveloperToolkit() {
  const tools = [
    {
      id: 'terminals',
      title: 'Integrated Terminals',
      badge: 'xterm.js · node-pty',
      desc: 'Real, high-performance terminal pool with full ANSI, WebGL acceleration, and session persistence across workspace switches.',
      spec: 'pty stream buffer / multi-tab terminal multiplexer'
    },
    {
      id: 'ide',
      title: 'Built-in Monaco Editor',
      badge: 'Syntax Highlighting',
      desc: 'Fast code exploration and editing without leaving Nexus. Code completion, multi-cursor, and real-time diff preview.',
      spec: 'Monaco editor / CodeMirror fallback'
    },
    {
      id: 'git',
      title: 'Git Graph & Commit Lineage',
      badge: 'Multi-Lane Graph',
      desc: 'Inspect linear history, multi-parent merges, working tree state, and uncommitted hunks. Every lane colored by design tokens.',
      spec: 'Native git binary / libgit2 inspection'
    },
    {
      id: 'mcp',
      title: 'MCP Server Ecosystem',
      badge: 'Model Context Protocol',
      desc: 'Expose local tools, databases, and filesystem scopes directly to agents through standard Model Context Protocol servers.',
      spec: 'MCP stdio & SSE transport support'
    },
    {
      id: 'skills',
      title: 'Extensible Skills Library',
      badge: 'Agent Skills',
      desc: 'Custom scripts, linters, and verification procedures that agents can dynamically discover and execute during development.',
      spec: 'JSON Schema contracts & script shims'
    },
    {
      id: 'shortcuts',
      title: 'Keyboard-Driven Command Palette',
      badge: '⌘K & ⌘J',
      desc: 'Every surface is reachable by keyboard. Instant jump to any workspace, project, agent session, or assistant prompt.',
      spec: 'Roving tabindex / zero-mouse workflow'
    }
  ];

  return (
    <section id="toolkit" className="nx-section nx-toolkit-section">
      <div className="nx-container">
        {/* Section Header */}
        <div className="nx-section-header">
          <div className="nx-section-badge">DEVELOPER TOOLKIT</div>
          <h2 className="nx-section-title">Your tools stay part of the workflow.</h2>
          <p className="nx-section-desc">
            Nexus unites your everyday developer utilities instead of replacing them. Terminals, editors, Git history,
            and MCP protocols remain native and responsive.
          </p>
        </div>

        {/* Technical Toolkit Grid */}
        <div className="nx-toolkit-grid">
          {tools.map((t) => (
            <div key={t.id} className="nx-tool-card">
              <div className="nx-tool-top">
                <span className="nx-tool-badge">{t.badge}</span>
                <span className="nx-tool-spec">{t.spec}</span>
              </div>
              <h3 className="nx-tool-title">{t.title}</h3>
              <p className="nx-tool-desc">{t.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

