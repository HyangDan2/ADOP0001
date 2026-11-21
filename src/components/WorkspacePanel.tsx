import { useState } from 'react';
import type { ToolId } from '../adapters/types';
import { isBinaryFile, languageTagFor, targetToolForFile } from '../lib/fileKinds';
import { openedFileFrom, type OpenedFile } from '../lib/fileBus';
import { saveExample } from '../lib/fewShotStore';
import {
  buildWorkspaceTree,
  countWorkspaceFiles,
  defaultExpanded,
  filesFromInput,
  filterWorkspaceTree,
  pickDirectory,
  type WorkspaceFileNode,
  type WorkspaceNode,
} from '../lib/workspace';

const MAX_ATTACH_BYTES = 512 * 1024;

export function WorkspacePanel(props: {
  activeToolId: ToolId;
  onOpenFile: (targetTool: ToolId, payload: OpenedFile) => void;
  onFewShotAdded: () => void;
  onCollapse: () => void;
}) {
  const [rootName, setRootName] = useState<string | null>(null);
  const [tree, setTree] = useState<WorkspaceNode[]>([]);
  const [files, setFiles] = useState<Map<string, File>>(new Map());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const announce = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(null), 2400);
  };

  const adopt = (name: string, entries: { path: string; file: File }[]) => {
    const nextFiles = new Map<string, File>();
    for (const entry of entries) nextFiles.set(entry.path, entry.file);
    setFiles(nextFiles);
    setRootName(name);
    const built = buildWorkspaceTree(entries.map((entry) => ({ path: entry.path, size: entry.file.size })));
    setTree(built);
    setExpanded(defaultExpanded(built, 1));
    setError(null);
    announce(`${name} を読み込みました（${countWorkspaceFiles(built)} ファイル）`);
  };

  const clickFolderInput = () => document.getElementById('workspace-folder-fallback')?.click();

  const openFolder = async () => {
    setError(null);
    // A picker cannot be automated, so automated browsers go straight to the input.
    const automated = typeof navigator !== 'undefined' && Boolean(navigator.webdriver);
    if (automated) {
      clickFolderInput();
      return;
    }
    setBusy(true);
    try {
      const picked = await pickDirectory();
      if (picked) {
        adopt(picked.name, picked.files);
        return;
      }
      clickFolderInput();
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return;
      setError('フォルダの選択を取りやめました。もう一度「フォルダを開く」を押してください。');
    } finally {
      setBusy(false);
    }
  };

  const toggleDir = (path: string) => setExpanded((current) => ({ ...current, [path]: !current[path] }));

  const openFile = async (node: WorkspaceFileNode) => {
    const file = files.get(node.path);
    if (!file) {
      setError('このファイルは読み込めませんでした。フォルダを開き直してください。');
      return;
    }
    const payload = await openedFileFrom(file, node.path);
    props.onOpenFile(targetToolForFile(node.path, props.activeToolId), payload);
  };

  const attachFewShot = async (node: WorkspaceFileNode) => {
    const file = files.get(node.path);
    if (!file) return;
    if (isBinaryFile(node.path)) {
      setError('バイナリ文書は Few-shot 例として保存できません。');
      return;
    }
    if (file.size > MAX_ATTACH_BYTES) {
      setError('512KB を超えるファイルは Few-shot 例にできません。');
      return;
    }
    await saveExample({
      toolId: props.activeToolId,
      title: node.name,
      outputFileName: node.name,
      outputText: await file.text(),
      targetLanguage: languageTagFor(node.name),
      enabled: true,
    });
    props.onFewShotAdded();
    announce(`${node.name} を Few-shot 例に追加しました`);
  };

  const visible = filterWorkspaceTree(tree, filter);

  const renderNodes = (nodes: WorkspaceNode[], depth: number) =>
    nodes.map((node) =>
      node.kind === 'dir' ? (
        <div key={node.path} className="ws-node">
          <button
            type="button"
            className="ws-dir"
            style={{ paddingLeft: 6 + depth * 12 }}
            aria-expanded={Boolean(expanded[node.path] ?? filter.trim())}
            onClick={() => toggleDir(node.path)}
            data-testid="workspace-dir"
            data-path={node.path}
          >
            <span className="ws-caret" aria-hidden="true">
              {expanded[node.path] || filter.trim() ? '▾' : '▸'}
            </span>
            <span className="ws-name">{node.name}</span>
            <span className="ws-count">{node.fileCount}</span>
          </button>
          {expanded[node.path] || filter.trim() ? <div className="ws-children">{renderNodes(node.children, depth + 1)}</div> : null}
        </div>
      ) : (
        <div key={node.path} className="ws-file-row">
          <button
            type="button"
            className="ws-file"
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={() => void openFile(node)}
            title={`${node.path} を開く`}
            data-testid="workspace-file"
            data-path={node.path}
          >
            <span className="ws-name">{node.name}</span>
          </button>
          <button
            type="button"
            className="ws-attach"
            aria-label={`${node.name} を Few-shot 例に追加`}
            title="Few-shot 例に追加"
            onClick={() => void attachFewShot(node)}
            data-testid="workspace-attach"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M20.2 11.6 12.1 19.7a4.6 4.6 0 0 1-6.5-6.5l8.1-8.1a3.1 3.1 0 1 1 4.4 4.4l-8 8a1.6 1.6 0 1 1-2.3-2.3l7.3-7.3" />
            </svg>
          </button>
        </div>
      ),
    );

  return (
    <aside className="ws-rail" aria-label="ワークスペース" data-testid="workspace-rail">
      <div className="ws-head">
        <span className="ws-title">ワークスペース</span>
        <button type="button" className="icon-btn ws-collapse" aria-label="ワークスペースを閉じる" title="ワークスペースを閉じる" onClick={props.onCollapse} data-testid="workspace-collapse">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M15 5 8 12l7 7" />
          </svg>
        </button>
      </div>

      <div className="ws-toolbar">
        <button type="button" className="btn btn-sm btn-primary ws-open" onClick={() => void openFolder()} disabled={busy} data-testid="workspace-open">
          {busy ? '読み込み中…' : 'フォルダを開く'}
        </button>
        <input
          id="workspace-folder-fallback"
          type="file"
          // The directory picker attribute is non-standard but supported by every major browser.
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          multiple
          style={{ display: 'none' }}
          data-testid="workspace-folder-input"
          onChange={(event) => {
            const list = event.target.files;
            event.target.value = '';
            if (!list || !list.length) return;
            const { root, files: entries } = filesFromInput(list);
            adopt(root || entries[0]?.path.split('/')[0] || 'フォルダ', entries);
          }}
        />
      </div>

      <label className="ws-filter">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="ファイル名で絞り込む"
          aria-label="ファイル名で絞り込む"
          data-testid="workspace-filter"
        />
      </label>

      <div className="ws-tree" data-testid="workspace-tree">
        {rootName ? (
          <>
            <div className="ws-root">
              <span>{rootName}</span>
              <span>{countWorkspaceFiles(tree)} ファイル</span>
            </div>
            {visible.length ? renderNodes(visible, 0) : <p className="ws-empty">一致するファイルがありません。</p>}
          </>
        ) : (
          <div className="ws-empty">
            <p>フォルダを開くと、ファイルをここから開いたり Few-shot 例に追加したりできます。</p>
            <p className="ws-hint">node_modules · .git · dist · build · .next は自動で除外します。</p>
          </div>
        )}
      </div>

      <div className="ws-foot">
        <span>クリックで開く · クリップで Few-shot</span>
        <span>PC（1024px 以上）専用</span>
      </div>
      {error ? <p className="ws-error">{error}</p> : null}
      {feedback ? <div className="toast">{feedback}</div> : null}
    </aside>
  );
}
