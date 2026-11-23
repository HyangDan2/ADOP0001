import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Emblem } from './components/Emblem';
import { HelpModal } from './components/HelpModal';
import { FewShotModal } from './components/FewShotModal';
import { PromptPane } from './components/PromptPane';
import { WorkspacePanel } from './components/WorkspacePanel';
import { TOOLS, toolFromHash, type ToolMeta } from './adapters/registry';
import type { ToolId } from './adapters/types';
import { publishOpenedFile, type OpenedFile } from './lib/fileBus';
import { activeExampleCounts } from './lib/fewShotStore';
import { resetAllDrafts } from './lib/drafts';
import { useMediaQuery } from './lib/useMediaQuery';
import { ShioriTool } from './tools/shiori/ShioriTool';
import { YayoiTool } from './tools/yayoi/YayoiTool';
import { KozueTool } from './tools/kozue/KozueTool';
import { HaruhiTool } from './tools/haruhi/HaruhiTool';
import { KotohaTool } from './tools/kotoha/KotohaTool';
import { TakaneTool } from './tools/takane/TakaneTool';

type Theme = 'dark' | 'light';
const THEME_KEY = 'adop0001.theme';
const RAIL_KEY = 'adop0001.workspace.open';

const ZERO_COUNTS: Record<ToolId, number> = { shiori: 0, yayoi: 0, kozue: 0, haruhi: 0, kotoha: 0, takane: 0 };

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'dark';
}

function initialRail(): boolean {
  try {
    const saved = localStorage.getItem(RAIL_KEY);
    if (saved === 'closed') return false;
  } catch {
    /* storage unavailable */
  }
  return true;
}

export default function App() {
  const [tool, setTool] = useState<ToolMeta>(() => toolFromHash(window.location.hash));
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [helpOpen, setHelpOpen] = useState(false);
  const [fewShotOpen, setFewShotOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(initialRail);
  const [counts, setCounts] = useState<Record<ToolId, number>>(ZERO_COUNTS);
  const [fewShotVersion, setFewShotVersion] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  /** Bumped after an explicit draft reset so the open tool re-reads empty storage. */
  const [draftEpoch, setDraftEpoch] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  /** The PC studio (rail + prompt pane) only exists on a wide screen (UI-002). */
  const desktop = useMediaQuery('(min-width: 1024px)');

  const refreshCounts = useCallback(() => {
    setFewShotVersion((value) => value + 1);
    void activeExampleCounts().then((next) => setCounts(next));
  }, []);

  useEffect(() => {
    refreshCounts();
  }, [refreshCounts]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, railOpen ? 'open' : 'closed');
    } catch {
      /* storage unavailable */
    }
  }, [railOpen]);

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
        setFewShotOpen(false);
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
      case 'takane':
        return <TakaneTool />;
      default:
        return <ShioriTool />;
    }
  }, [tool.id]);

  const go = (id: string) => {
    window.location.hash = `#/${id}`;
    setTool(toolFromHash(`#/${id}`));
    setMenuOpen(false);
  };

  const resetDrafts = async () => {
    await resetAllDrafts(TOOLS.map((item) => item.id));
    setDraftEpoch((value) => value + 1);
    setMenuOpen(false);
    // Remounting is not enough: a tool that still holds its document in memory
    // re-saves it on unmount, so "init" could keep showing the old file. A hard
    // reload starts every tool from the cleared store; the hash keeps the tool.
    window.location.reload();
  };

  const openFromWorkspace = (targetTool: ToolId, payload: OpenedFile) => {
    if (targetTool !== tool.id) go(targetTool);
    publishOpenedFile(targetTool, payload);
  };

  return (
    <div className={`app-shell ${railOpen ? 'rail-open' : 'rail-closed'}`}>
      <header className="topbar">
        <a className="brand" href="#/shiori" onClick={() => go('shiori')} aria-label="HD2Lab 青松館 ホーム">
          <span style={{ color: 'var(--accent)' }}>
            <Emblem size={28} />
          </span>
          <span className="brand-title">
            <b>HD2Lab 青松館</b>
            <span>6-in-1 スイート</span>
          </span>
        </a>
        <span className="brand-divider" aria-hidden="true" />
        <nav className="tool-switcher" aria-label="ツール切り替え">
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
              <span className="en">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          {desktop ? (
            <button
              type="button"
              className="chip-btn ws-toggle"
              aria-pressed={railOpen}
              aria-label={railOpen ? 'ワークスペースをたたむ' : 'ワークスペースを開く'}
              title={railOpen ? 'ワークスペースをたたむ' : 'ワークスペースを開く'}
              onClick={() => setRailOpen((open) => !open)}
              data-testid="workspace-toggle"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="M9 5v14" />
              </svg>
              <span className="chip-label">ワークスペース</span>
            </button>
          ) : null}
          <button
            type="button"
            className="chip-btn fs-open"
            aria-label="Few-shot 例とプロンプトを開く"
            title="Few-shot 例とプロンプト"
            onClick={() => setFewShotOpen(true)}
            data-testid="fewshot-button"
          >
            <span className="chip-label">Few-shot例</span>
            <span className="chip-short">例</span>
            <span className="chip-count" data-testid="fewshot-count">({counts[tool.id] ?? 0})</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={theme === 'dark' ? 'ライトテーマに切り替え' : 'ダークテーマに切り替え'}
            title={theme === 'dark' ? 'Mist Pine（ライト）' : 'Deep Cedar（ダーク）'}
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
            aria-label="ヘルプを開く"
            title="ヘルプ（?）"
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
              aria-label="メニューを開く"
              aria-expanded={menuOpen}
              title="その他"
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
                <div className="menu-group">ツール</div>
                {TOOLS.map((item) => (
                  <button key={item.id} type="button" role="menuitem" onClick={() => go(item.id)}>
                    <span className="menu-jp">{item.japanese}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
                <div className="menu-sep" />
                <div className="menu-group">作業データ</div>
                <button type="button" role="menuitem" onClick={() => void resetDrafts()} data-testid="reset-drafts">
                  <span className="menu-jp">初期化</span>
                  <span>下書きをすべて破棄</span>
                </button>
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
                  <span className="menu-jp">GitHub</span>
                  <span>GitHub リポジトリ</span>
                </a>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="app-body">
        {railOpen && desktop ? (
          <WorkspacePanel
            activeToolId={tool.id}
            onOpenFile={openFromWorkspace}
            onFewShotAdded={refreshCounts}
            onCollapse={() => setRailOpen(false)}
          />
        ) : null}

        <main className="workspace" key={`${tool.id}:${draftEpoch}`}>
          <div className="tool-head">
            <div>
              <h1>
                <span className="jp">{tool.japanese}</span>
                <span>{tool.label}</span>
              </h1>
              <p>{tool.longDescription}</p>
            </div>
            <div className="head-actions">
              <span className="badge soft">ブラウザ完結</span>
              <span className="badge">ローカル静的解析</span>
            </div>
          </div>
          {desktop ? (
            <PromptPane
              tool={tool}
              version={fewShotVersion}
              onOpenManager={() => setFewShotOpen(true)}
              onChanged={refreshCounts}
            />
          ) : null}
          {body}
        </main>
      </div>

      {helpOpen ? <HelpModal tool={tool} onClose={() => setHelpOpen(false)} /> : null}
      {fewShotOpen ? (
        <FewShotModal tool={tool} onClose={() => setFewShotOpen(false)} onChanged={refreshCounts} />
      ) : null}
    </div>
  );
}
