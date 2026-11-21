import { useEffect, useMemo, useRef, useState } from 'react';
import { Emblem } from './components/Emblem';
import { HelpModal } from './components/HelpModal';
import { TOOLS, toolFromHash, type ToolMeta } from './adapters/registry';
import { ShioriTool } from './tools/shiori/ShioriTool';
import { YayoiTool } from './tools/yayoi/YayoiTool';
import { KozueTool } from './tools/kozue/KozueTool';
import { HaruhiTool } from './tools/haruhi/HaruhiTool';
import { KotohaTool } from './tools/kotoha/KotohaTool';

type Theme = 'dark' | 'light';
const THEME_KEY = 'adop0001.theme';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'dark';
}

export default function App() {
  const [tool, setTool] = useState<ToolMeta>(() => toolFromHash(window.location.hash));
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [helpOpen, setHelpOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  useEffect(() => {
    const onHash = () => setTool(toolFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    if (!window.location.hash) window.location.replace(`${window.location.pathname}#/shiori`);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setHelpOpen(false);
      }
      if (event.key === '?' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
        setHelpOpen((open) => !open);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const body = useMemo(() => {
    switch (tool.id) {
      case 'shiori':
        return <ShioriTool />;
      case 'yayoi':
        return <YayoiTool />;
      case 'kozue':
        return <KozueTool />;
      case 'haruhi':
        return <HaruhiTool />;
      case 'kotoha':
        return <KotohaTool />;
      default:
        return <ShioriTool />;
    }
  }, [tool.id]);

  const go = (id: string) => {
    window.location.hash = `#/${id}`;
    setTool(toolFromHash(`#/${id}`));
    setMenuOpen(false);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#/shiori" onClick={() => go('shiori')} aria-label="HD2Lab Aosongkan home">
          <span style={{ color: 'var(--accent)' }}>
            <Emblem size={28} />
          </span>
          <span className="brand-title">
            <b>HD2Lab 青松館</b>
            <span>5-in-1 suite</span>
          </span>
        </a>
        <span className="brand-divider" aria-hidden="true" />
        <nav className="tool-switcher" aria-label="Tool switcher">
          {TOOLS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="tool-chip"
              aria-current={item.id === tool.id}
              onClick={() => go(item.id)}
              data-testid={`tab-${item.id}`}
            >
              <span className="jp">{item.japanese}</span>
              <span className="en">{item.english}</span>
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Mist Pine (light)' : 'Deep Cedar (dark)'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            data-testid="theme-toggle"
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="4.2" />
                <path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Open help"
            title="Help (?)"
            onClick={() => setHelpOpen(true)}
            data-testid="help-button"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M9.6 9.2a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.9" strokeLinecap="round" />
              <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
            </svg>
          </button>
          <div className="menu-wrap" ref={menuRef}>
            <button
              type="button"
              className="icon-btn"
              aria-label="Open menu"
              aria-expanded={menuOpen}
              title="More"
              onClick={() => setMenuOpen((open) => !open)}
              data-testid="kebab-button"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="1.7" />
                <circle cx="12" cy="12" r="1.7" />
                <circle cx="12" cy="19" r="1.7" />
              </svg>
            </button>
            {menuOpen ? (
              <div className="menu" role="menu" data-testid="kebab-menu">
                <div className="menu-group">Tools</div>
                {TOOLS.map((item) => (
                  <button key={item.id} type="button" role="menuitem" onClick={() => go(item.id)}>
                    <span className="menu-jp">{item.japanese}</span>
                    <span>{item.english}</span>
                  </button>
                ))}
                <div className="menu-sep" />
                <div className="menu-group">HD2Lab</div>
                <a href="https://hyangdan2.github.io/" role="menuitem" target="_blank" rel="noreferrer">
                  <span className="menu-jp">HQ</span>
                  <span>HD2Lab Web-HQ</span>
                </a>
                <a
                  href="https://hyangdan2.github.io/ApplicationHub/"
                  role="menuitem"
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="menu-jp">Hub</span>
                  <span>ApplicationHub</span>
                </a>
                <div className="menu-sep" />
                <a href="https://github.com/HyangDan2/ADOP0001" role="menuitem" target="_blank" rel="noreferrer">
                  <span className="menu-jp">Src</span>
                  <span>Source on GitHub</span>
                </a>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className="workspace" key={tool.id}>
        <div className="tool-head">
          <div>
            <h1>
              <span className="jp">{tool.japanese}</span>
              <span>{tool.english}</span>
            </h1>
            <p>{tool.longDescription}</p>
          </div>
          <div className="head-actions">
            <span className="badge soft">100% in-browser</span>
            <span className="badge">Local static engine</span>
          </div>
        </div>
        {body}
      </main>

      {helpOpen ? <HelpModal tool={tool} onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}
