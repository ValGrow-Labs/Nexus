import { GITHUB_REPO_URL } from '../data/navigation';

export function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="nx-footer">
      <div className="nx-container">
        <div className="nx-footer-top">
          {/* Brand Left */}
          <div className="nx-footer-brand">
            <div className="nx-footer-logo-row">
              <svg className="nx-brand-icon" width="22" height="22" viewBox="0 0 32 32" fill="none">
                <rect width="32" height="32" rx="6" fill="#18181B" />
                <path d="M7 8H11V24H7V8Z" fill="#A78BFA" />
                <path d="M11 11L21 21H25V19L15 9H11V11Z" fill="#818CF8" />
                <path d="M21 8H25V24H21V8Z" fill="#C084FC" />
              </svg>
              <span className="nx-footer-brand-name">Nexus</span>
              <span className="nx-footer-badge">Phase A Beta</span>
            </div>
            <p className="nx-footer-tagline">
              The AI-native development platform. Unifying projects, AI coding agents, and real developer tools
              in a local-first desktop workspace.
            </p>
            <div className="nx-footer-valgrow">
              <span>Developed by <strong>ValGrow Labs</strong></span>
            </div>
          </div>

          {/* Links Columns */}
          <div className="nx-footer-cols">
            <div className="nx-footer-col">
              <span className="nx-col-title">Product</span>
              <ul className="nx-col-links">
                <li><a href="#product">Overview</a></li>
                <li><a href="#experience">The Experience</a></li>
                <li><a href="#workspaces">Intelligent Workspaces</a></li>
                <li><a href="#agents">AI Agent Harness</a></li>
                <li><a href="#toolkit">Developer Toolkit</a></li>
              </ul>
            </div>

            <div className="nx-footer-col">
              <span className="nx-col-title">Engineering</span>
              <ul className="nx-col-links">
                <li><a href="#local-first">Local-First Architecture</a></li>
                <li><a href="#local-first">Telemetry Contract</a></li>
                <li><a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer noopener">Source Code</a></li>
                <li><a href={`${GITHUB_REPO_URL}/releases`} target="_blank" rel="noreferrer noopener">Releases</a></li>
              </ul>
            </div>

            <div className="nx-footer-col">
              <span className="nx-col-title">Open Source</span>
              <ul className="nx-col-links">
                <li><a href={`${GITHUB_REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer noopener">MIT License</a></li>
                <li><a href={`${GITHUB_REPO_URL}/blob/main/CONTRIBUTING.md`} target="_blank" rel="noreferrer noopener">Contributing</a></li>
                <li><a href={`${GITHUB_REPO_URL}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer noopener">Security Policy</a></li>
                <li><a href={`${GITHUB_REPO_URL}/issues`} target="_blank" rel="noreferrer noopener">Issue Tracker</a></li>
              </ul>
            </div>
          </div>
        </div>

        <div className="nx-footer-bottom">
          <div className="nx-footer-copy">
            <span>&copy; {currentYear} ValGrow Labs. Open source under the MIT License.</span>
          </div>

          <div className="nx-footer-status">
            <span className="nx-status-dot is-online" />
            <span>Phase A Beta · Local-first desktop platform</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

