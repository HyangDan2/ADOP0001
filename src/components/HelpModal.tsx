import type { ToolMeta } from '../adapters/registry';
import { TOOLS } from '../adapters/registry';

export function HelpModal({ tool, onClose }: { tool: ToolMeta; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="ヘルプ" data-testid="help-modal">
        <button type="button" className="icon-btn modal-close" aria-label="ヘルプを閉じる" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 5l14 14M19 5 5 19" strokeLinecap="round" />
          </svg>
        </button>
        <h2>
          <span className="jp">青松館</span>
          <span>ヘルプ</span>
        </h2>
        <p>
          100% ブラウザ完結。青松館（Aomatsukan）は、このブラウザタブの中だけで動作する6つの開発・文書ツールです。
          ソースコード・文書・スタイルバンドルが端末の外へ出ることはなく、サーバーへの送信も一切ありません。
        </p>

        <h3>{tool.japanese} — {tool.label}</h3>
        <p>{tool.longDescription}</p>
        <ul>
          {tool.adapter.capabilities.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>

        <h3>操作のしかた</h3>
        <ul>
          <li>上部バーのツールチップ、または <code>⋮</code> メニューでツールを切り替えます。各ツールには固有のアドレスがあります（<code>#/shiori</code>、<code>#/yayoi</code>、<code>#/kozue</code>、<code>#/haruhi</code>、<code>#/kotoha</code>、<code>#/takane</code>）。</li>
          <li>太陽／月のボタンで Deep Cedar（ダーク）と Mist Pine（ライト）を切り替えます。選択内容はこの端末に保存されます。</li>
          <li>コードを貼り付けるか、ファイルをドロップするか、サンプルのチップを押して開始します。ファイルがブラウザの外へ出ることはありません。</li>
          <li><code>?</code> または <code>Ctrl</code>／<code>Cmd</code> + <code>K</code> でこのヘルプを開き、<code>Esc</code> で閉じます。</li>
        </ul>

        <h3>6つのツール</h3>
        <ul>
          {TOOLS.map((item) => (
            <li key={item.id}>
              <strong>{item.japanese}</strong>（{item.label}）: {item.tagline}
            </li>
          ))}
        </ul>

        <h3>プライバシー</h3>
        <p>
          オプションAのエンジンは決定的なローカル処理です。琴葉はスタイルバンドルをこのブラウザの
          IndexedDB に保持し、必要なら <code>.kotoha.json</code> として書き出すこともできます。
          将来のハイブリッド AI モード（オプションB）はリクエストごとの明示的な同意を前提とし、
          <code>ARCHITECTURE.md</code> に記載しています。
        </p>
      </div>
    </div>
  );
}
