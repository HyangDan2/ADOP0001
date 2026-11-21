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
          <li>上部バーのツール名、または <code>⋮</code> メニューでツールを切り替えます。各ツールには固有のアドレスがあります（<code>#/shiori</code>、<code>#/yayoi</code>、<code>#/kozue</code>、<code>#/haruhi</code>、<code>#/kotoha</code>、<code>#/takane</code>）。</li>
          <li>太陽／月のボタンで Deep Cedar（ダーク）と Mist Pine（ライト）を切り替えます。選択内容はこの端末に保存されます。</li>
          <li>コードを貼り付けるか、ファイルをドロップするか、サンプルのボタンを押して開始します。ファイルがブラウザの外へ出ることはありません。</li>
          <li><code>?</code> または <code>Ctrl</code>／<code>Cmd</code> + <code>K</code> でこのヘルプを開き、<code>Esc</code> で閉じます。</li>
          <li>各ツールの入力欄の「ファイルを開く」から、コード・仕様書・<code>.docx</code> を直接読み込めます。</li>
        </ul>

        <h3>ワークスペース（PC・1024px 以上）</h3>
        <ul>
          <li>左のワークスペースで「フォルダを開く」を押すと、フォルダ内のファイルをツリーで一覧できます。<code>node_modules</code>、<code>.git</code>、<code>dist</code>、<code>build</code>、<code>.next</code> は自動で除外します。</li>
          <li>ファイル名で絞り込み、ファイルをクリックすると、種類に応じて中央下の入力欄へ読み込みます。コードは選択中のコードツール、仕様書（<code>.md</code>／<code>.txt</code>）は貴音、<code>.docx</code> は琴葉が受け取ります。</li>
          <li>ツリーのクリップ・アイコンで、そのファイルをそのまま Few-shot 例に追加できます。</li>
          <li>上部の「ワークスペース」ボタンで、左の列を畳んだり開いたりできます。</li>
        </ul>

        <h3>プロンプト · Few-shot例</h3>
        <ul>
          <li>PC では中央上の欄に、このツールへの追加指示と Few-shot 例を置けます。指示はこの端末に保存されます。</li>
          <li>プロンプト欄の右下のクリップ、または上部の「Few-shot例」から、例の追加・編集・有効化・削除ができます。</li>
          <li>入力ファイルと出力ファイルを1組にして保存するか、出力だけの参照例として保存できます。トークン数は概算で表示します。</li>
          <li>「プロンプト合成プレビュー」では、オプションBで送信される組み立て（システム指示 → 追加指示 → 有効な例 → 対象ソース）を確認できます。現在は<strong>ローカル保存のみ・送信なし</strong>です。</li>
          <li>例の一式は <code>.fewshot.json</code> として書き出し・読み込みできます。</li>
        </ul>

        <h3>エクスポート</h3>
        <ul>
          <li>各ツールの出力欄にある「エクスポート」から、ファイル名を確かめて必要な形式を書き出せます。コピーもそこにまとまっています。</li>
          <li>貴音は Python・C・C++・MCU の4言語を、その場で生成して書き出せます（MCU は <code>&lt;stdint.h&gt;</code> の固定幅整数と <code>MCU_ERR_*</code> 状態コードを使います）。</li>
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
          オプションAのエンジンは、同じ入力からは常に同じ結果を返すローカル処理です。琴葉はスタイルバンドルをこのブラウザの
          IndexedDB に保持し、必要なら <code>.kotoha.json</code> として書き出すこともできます。
          Few-shot 例とプロンプトの追加指示もこのブラウザにだけ保存され、オプションAでは送信しません。
          将来のハイブリッド AI モード（オプションB）はリクエストごとの明示的な同意を前提とし、有効な例だけを秘匿情報の伏字とトークン上限つきで送信します。
          詳しくは <code>ARCHITECTURE.md</code> に記載しています。
        </p>
      </div>
    </div>
  );
}
