import type { ToolId } from './types';
import type { TypedEngineAdapter } from '../engine/core/contracts';
import { ShioriAdapter } from '../tools/shiori/adapter';
import { YayoiAdapter } from '../tools/yayoi/adapter';
import { KozueAdapter } from '../tools/kozue/adapter';
import { HaruhiAdapter } from '../tools/haruhi/adapter';
import { KotohaAdapter } from '../tools/kotoha/adapter';
import { TakaneAdapter } from '../tools/takane/adapter';

export interface ToolMetaOf<K extends ToolId> {
  id: K;
  path: string;
  /** Japanese brand title, e.g. 枝織. */
  japanese: string;
  /** Japanese switcher label shown beside the brand title. */
  label: string;
  tagline: string;
  longDescription: string;
  adapter: TypedEngineAdapter<K>;
}

/** Each tool keeps its own option/output types through the whole registry. */
export type ToolMeta = { [K in ToolId]: ToolMetaOf<K> }[ToolId];

const ADAPTERS = {
  shiori: new ShioriAdapter(),
  yayoi: new YayoiAdapter(),
  kozue: new KozueAdapter(),
  haruhi: new HaruhiAdapter(),
  kotoha: new KotohaAdapter(),
  takane: new TakaneAdapter(),
} as const;

/**
 * Engine registry. Every tool is resolved through this table, so a future
 * `hybrid-ai` adapter can replace a `local-static` one without touching the UI.
 */
export const TOOLS: readonly ToolMeta[] = [
  {
    id: 'shiori',
    path: '#/shiori',
    japanese: '枝織',
    label: '仕様書作成',
    tagline: 'ソースコードを契約水準の仕様書へ織り上げます。',
    longDescription:
      'TypeScript・JavaScript・Python・Java・Go を解析し、モジュール・型・シグネチャ・ガード・エラー経路・依存関係を抽出して、契約表と振る舞いルールを Markdown またはスタンドアロンの HTML として出力します。',
    adapter: ADAPTERS.shiori,
  },
  {
    id: 'yayoi',
    path: '#/yayoi',
    japanese: '弥生',
    label: '擬似コード',
    tagline: '文法のノイズを削り、思考だけを残します。',
    longDescription:
      '言語固有の記法を取り除き、制御フローを読みやすい擬似コードとして3つのスタイルで出力します。詳細・要約の2段階の深さと、元ソースへの行単位の対応付けを備えています。',
    adapter: ADAPTERS.yayoi,
  },
  {
    id: 'kozue',
    path: '#/kozue',
    japanese: '梢絵',
    label: 'UML自動設計',
    tagline: 'コードの形に合う図を、自動で選びます。',
    longDescription:
      'ソース構造から5種類の UML を採点し、最適な種類とその理由を提示したうえで、シーケンス図・クラス図・ステート図・アクティビティ図・コンポーネント図を Mermaid で描画します。パン・ズームと SVG／PNG 書き出しに対応しています。',
    adapter: ADAPTERS.kozue,
  },
  {
    id: 'haruhi',
    path: '#/haruhi',
    japanese: '春日',
    label: 'テスト生成',
    tagline: 'コードから、必要なテストケースを鍛え上げます。',
    longDescription:
      'ソースから正常系・境界値・ガード分岐・エラー経路を導き、Vitest／Jest・Pytest・JUnit 5・Go testing 向けの Given/When/Then 雛形を、未カバー分岐チェックリストとともに出力します。',
    adapter: ADAPTERS.haruhi,
  },
  {
    id: 'kotoha',
    path: '#/kotoha',
    japanese: '琴葉',
    label: 'Docx↔MD往復',
    tagline: '言葉を直し、テンプレートはそのまま。',
    longDescription:
      '.docx を Markdown へ分解する際に、スタイル・テーマ・番号付け・ヘッダー・フッター・メディア・ページ設定をスタイルバンドルとして保持し、元の見た目を保ったまま有効な .docx へ再構築します。',
    adapter: ADAPTERS.kotoha,
  },
  {
    id: 'takane',
    path: '#/takane',
    japanese: '貴音',
    label: '仕様書→コード',
    tagline: '仕様書から、動くコードの骨格を。',
    longDescription:
      '構造化された Markdown 仕様書から、型宣言・関数シグネチャ・ガード節・エラー経路・Doc コメントを備えたスキャフォールドを、Python・C・C++・MCU 向けに生成します。MCU は固定幅整数と静的バッファ、状態コードだけを使う組み込み向けの C です。枝織の出力をそのまま読み込めるので、コード→仕様書→コードの往復をブラウザ内で確かめられます。',
    adapter: ADAPTERS.takane,
  },
];

/** Typed access to the singleton adapter for a tool. */
export function adapterFor(id: 'shiori'): TypedEngineAdapter<'shiori'>;
export function adapterFor(id: 'yayoi'): TypedEngineAdapter<'yayoi'>;
export function adapterFor(id: 'kozue'): TypedEngineAdapter<'kozue'>;
export function adapterFor(id: 'haruhi'): TypedEngineAdapter<'haruhi'>;
export function adapterFor(id: 'kotoha'): TypedEngineAdapter<'kotoha'>;
export function adapterFor(id: 'takane'): TypedEngineAdapter<'takane'>;
export function adapterFor(id: ToolId): TypedEngineAdapter<ToolId>;
export function adapterFor(id: ToolId): TypedEngineAdapter<ToolId> {
  return ADAPTERS[id];
}

export function toolById(id: string | undefined): ToolMeta {
  return TOOLS.find((tool) => tool.id === id) ?? TOOLS[0];
}

export function toolFromHash(hash: string): ToolMeta {
  const match = hash.match(/^#\/([a-z]+)/);
  return toolById(match?.[1]);
}
