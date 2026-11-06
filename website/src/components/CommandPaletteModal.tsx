import React, { useEffect, useRef, useState } from 'react';
import { WORKSPACES } from '../data/workspaces';
import { GITHUB_REPO_URL } from '../data/navigation';
import { ProvenanceMark } from './ProvenanceMark';

interface CommandPaletteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onToggleTheme: () => void;
  theme: 'dark' | 'light';
}

interface CommandItem {
  id: string;
  category: string;
  label: string;
  detail?: string;
  badge?: string;
  hueSlot?: number;
  action: () => void;
}

export function CommandPaletteModal({ isOpen, onClose, onToggleTheme, theme }: CommandPaletteModalProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const scrollTo = (hash: string) => {
    onClose();
    const el = document.querySelector(hash);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const copyQuickstart = () => {
    navigator.clipboard.writeText('git clone https://github.com/ValGrow-Labs/Nexus.git && cd Nexus && npm install && npm run dev');
    onClose();
  };

  const allItems: CommandItem[] = [
    // Navigation
    { id: 'nav-product', category: 'Navigation', label: 'Go to Product Showcase', detail: 'Overview & interactive desktop preview', action: () => scrollTo('#product') },
    { id: 'nav-experience', category: 'Navigation', label: 'Go to The Nexus Experience', detail: 'Core workflow & 4-step loop', action: () => scrollTo('#experience') },
    { id: 'nav-workspaces', category: 'Navigation', label: 'Go to Workspaces', detail: '8 discipline workspaces & golden-angle hues', action: () => scrollTo('#workspaces') },
    { id: 'nav-agents', category: 'Navigation', label: 'Go to AI Agents', detail: 'Real terminal pty & local hive orchestration', action: () => scrollTo('#agents') },
    { id: 'nav-local-first', category: 'Navigation', label: 'Go to Local-First & Privacy', detail: 'SQLite engine & telemetry contract', action: () => scrollTo('#local-first') },
    { id: 'nav-toolkit', category: 'Navigation', label: 'Go to Developer Toolkit', detail: 'IDE, terminals, git history & MCP catalog', action: () => scrollTo('#toolkit') },
    { id: 'nav-quickstart', category: 'Navigation', label: 'Go to Quickstart & Setup', detail: 'Clone and launch instructions', action: () => scrollTo('#get-nexus') },
    // Actions
    { id: 'act-theme', category: 'Actions', label: `Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Theme`, detail: 'Spine design system theme toggle', badge: 'Theme', action: () => { onToggleTheme(); onClose(); } },
    { id: 'act-copy', category: 'Actions', label: 'Copy Quickstart Clone Command', detail: 'git clone ... && npm run dev', badge: 'Clipboard', action: copyQuickstart },
    { id: 'act-github', category: 'Actions', label: 'Open GitHub Repository', detail: 'github.com/ValGrow-Labs/Nexus', badge: 'External', action: () => { window.open(GITHUB_REPO_URL, '_blank'); onClose(); } },
    // Workspaces
    ...WORKSPACES.map((w) => ({
      id: `ws-${w.id}`,
      category: 'Workspaces',
      label: `${w.name} (${w.label})`,
      detail: w.tagline,
      hueSlot: w.hueSlot,
      action: () => scrollTo('#workspaces')
    }))
  ];

  const filtered = allItems.filter((item) => {
    const q = query.toLowerCase().trim();
    if (!q) return true;
    return item.label.toLowerCase().includes(q) || (item.detail && item.detail.toLowerCase().includes(q)) || item.category.toLowerCase().includes(q);
  });

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        filtered[selectedIndex].action();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="nx-palette-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Command Palette">
      <div className="nx-palette-window" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="nx-palette-searchbox">
          <svg className="nx-palette-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="nx-palette-input"
            placeholder="Type a command, workspace, or section..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="nx-palette-kbd">ESC</kbd>
        </div>

        <div className="nx-palette-list" role="listbox">
          {filtered.length === 0 ? (
            <div className="nx-palette-empty">No results found for &ldquo;{query}&rdquo;</div>
          ) : (
            filtered.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={isSelected}
                  className={`nx-palette-item ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => item.action()}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <div className="nx-palette-item-left">
                    {item.hueSlot !== undefined ? (
                      <ProvenanceMark hueSlot={item.hueSlot} size={8} />
                    ) : (
                      <span className="nx-palette-category-bullet" />
                    )}
                    <span className="nx-palette-item-label">{item.label}</span>
                    {item.detail && <span className="nx-palette-item-detail">{item.detail}</span>}
                  </div>
                  {item.badge && <span className="nx-palette-badge">{item.badge}</span>}
                </div>
              );
            })
          )}
        </div>

        <div className="nx-palette-footer">
          <span className="nx-palette-tip">Use <kbd>↑</kbd> <kbd>↓</kbd> to navigate, <kbd>↵</kbd> to select, <kbd>ESC</kbd> to close</span>
          <span className="nx-palette-brand">Nexus by ValGrow Labs</span>
        </div>
      </div>
    </div>
  );
}

