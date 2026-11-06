import React, { useEffect, useState } from 'react';
import { NAV_LINKS, GITHUB_REPO_URL } from '../data/navigation';

interface NavbarProps {
  onOpenPalette: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export function Navbar({ onOpenPalette, theme, onToggleTheme }: NavbarProps) {
  const [isScrolled, setIsScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <>
      <header className={`nx-navbar ${isScrolled ? 'is-scrolled' : ''}`}>
        <div className="nx-container nx-navbar-inner">
          {/* Brand Left */}
          <a href="#" className="nx-navbar-brand" aria-label="Nexus by ValGrow Labs">
            <svg className="nx-brand-icon" width="24" height="24" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="6" fill="#18181B" />
              <path d="M7 8H11V24H7V8Z" fill="#A78BFA" />
              <path d="M11 11L21 21H25V19L15 9H11V11Z" fill="#818CF8" />
              <path d="M21 8H25V24H21V8Z" fill="#C084FC" />
            </svg>
            <div className="nx-brand-text">
              <span className="nx-brand-title">Nexus</span>
              <span className="nx-brand-creator">By ValGrow Labs</span>
            </div>
            <span className="nx-badge-beta">Phase A</span>
          </a>

          {/* Navigation Links Middle */}
          <nav className="nx-nav-links" aria-label="Primary Navigation">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} className="nx-nav-link">
                {link.label}
              </a>
            ))}
          </nav>

          {/* Actions Right */}
          <div className="nx-navbar-actions">
            {/* Command Palette Trigger */}
            <button
              type="button"
              className="nx-btn-search"
              onClick={onOpenPalette}
              aria-label="Open Command Palette"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <span className="nx-search-label">Search</span>
              <kbd className="nx-search-kbd">⌘K</kbd>
            </button>

            {/* Theme Toggle */}
            <button
              type="button"
              className="nx-icon-btn"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
              title={theme === 'dark' ? 'Light Theme' : 'Dark Theme'}
            >
              {theme === 'dark' ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" />
                  <line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
                </svg>
              )}
            </button>

            {/* GitHub Link */}
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="nx-btn-github"
              aria-label="View Nexus on GitHub"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
              <span>GitHub</span>
            </a>

            {/* Primary CTA */}
            <a href="#get-nexus" className="nx-btn-primary">
              Get Nexus
            </a>

            {/* Mobile Hamburger */}
            <button
              type="button"
              className="nx-btn-mobile-toggle"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Toggle mobile menu"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {mobileMenuOpen ? (
                  <>
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </>
                ) : (
                  <>
                    <line x1="3" y1="12" x2="21" y2="12"></line>
                    <line x1="3" y1="6" x2="21" y2="6"></line>
                    <line x1="3" y1="18" x2="21" y2="18"></line>
                  </>
                )}
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="nx-mobile-menu" role="dialog" aria-modal="true">
          <div className="nx-mobile-links">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="nx-mobile-link"
                onClick={() => setMobileMenuOpen(false)}
              >
                {link.label}
              </a>
            ))}
          </div>
          <div className="nx-mobile-actions">
            <a
              href="#get-nexus"
              className="nx-btn-primary nx-w-full"
              onClick={() => setMobileMenuOpen(false)}
            >
              Get Nexus
            </a>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="nx-btn-secondary nx-w-full"
            >
              View on GitHub
            </a>
          </div>
        </div>
      )}
    </>
  );
}

