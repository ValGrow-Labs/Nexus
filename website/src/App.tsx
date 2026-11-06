import { useEffect, useState } from 'react';
import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { ProductShowcase } from './components/ProductShowcase';
import { Experience } from './components/Experience';
import { WorkspacesSection } from './components/WorkspacesSection';
import { AgentsSection } from './components/AgentsSection';
import { DeveloperToolkit } from './components/DeveloperToolkit';
import { LocalFirstSection } from './components/LocalFirstSection';
import { FinalCta } from './components/FinalCta';
import { Footer } from './components/Footer';
import { CommandPaletteModal } from './components/CommandPaletteModal';

export function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Sync theme to root DOM node
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Global ⌘K / Ctrl+K listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  return (
    <div className="nx-site-wrapper">
      <Navbar
        onOpenPalette={() => setPaletteOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <main id="main-content">
        <Hero />
        <ProductShowcase />
        <Experience />
        <WorkspacesSection />
        <AgentsSection />
        <DeveloperToolkit />
        <LocalFirstSection />
        <FinalCta />
      </main>

      <Footer />

      <CommandPaletteModal
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onToggleTheme={toggleTheme}
        theme={theme}
      />
    </div>
  );
}

