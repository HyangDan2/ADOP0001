/**
 * Kotoha (琴葉) engine adapter — docx decompose, markdown rebuild, sample generation.
 */

import type { EngineAdapter, EngineRequest, EngineResult, ProviderMode } from '../../adapters/types';
import { baseName, sha256Hex } from '../../lib/util';
import { mergeAttributes, type BundleAttributes, type KotohaBundle, type LossWarning } from './bundle';
import { decomposeDocx } from './read';
import { rebuildDocx } from './write';
import { buildSampleDocx } from './sample';

export type KotohaAction = 'decompose' | 'rebuild' | 'sample';

export interface KotohaOptions {
  action: KotohaAction;
  bytes?: Uint8Array | ArrayBuffer;
  markdown?: string;
  bundle?: KotohaBundle;
  attributes?: Partial<BundleAttributes>;
  fileName?: string;
}

export interface KotohaOutput {
  action: KotohaAction;
  fileName: string;
  markdown: string;
  bundle: KotohaBundle;
  docx?: Uint8Array;
  paragraphs?: number;
  tables?: number;
  /** Structural limits hit while reading (KOT-001/KOT-002). */
  warnings: LossWarning[];
  /** On rebuild: how many preserved blocks were written back verbatim. */
  restoredBlocks?: number;
  /** On rebuild: package entries carried over from the original container. */
  restoredParts?: number;
  /** On rebuild: markers whose block id no longer exists in the bundle. */
  unknownMarkers?: string[];
}

export class KotohaAdapter implements EngineAdapter<KotohaOutput, KotohaOptions> {
  readonly id = 'kotoha' as const;
  readonly title = 'Docx ↔ MD Round-Trip';
  readonly japaneseTitle = '琴葉';
  readonly providerMode: ProviderMode = 'local-static';
  readonly capabilities = [
    'OOXML の document.xml から、スタイル・リスト・表・リンク・メディアを保って Markdown へ',
    'スタイル・テーマ・番号付け・ヘッダー・フッター・余白を保持するスタイルバンドル（.kotoha.json + IndexedDB）',
    'Markdown で表せない要素は原本のまま保持し、制限は変換前に一覧で警告',
    'フォント・サイズ・行間・余白・見出し色を編集できるスタイル＆属性インスペクタ',
    'Markdown から元の見た目を保った有効な .docx への再構築',
    'ワンクリックでサンプル .docx を生成',
  ] as const;

  async run(request: EngineRequest<KotohaOptions>): Promise<EngineResult<KotohaOutput>> {
    const started = performance.now();
    const options = request.options;
    let output: KotohaOutput;

    if (options.action === 'sample') {
      const bytes = await buildSampleDocx();
      const document = await decomposeDocx(bytes, 'kotoha-sample.docx');
      output = {
        action: 'sample',
        fileName: 'kotoha-sample.docx',
        markdown: document.markdown,
        bundle: document.bundle,
        docx: bytes,
        paragraphs: document.bundle.stats.paragraphs,
        tables: document.bundle.stats.tables,
        warnings: document.bundle.warnings ?? [],
      };
    } else if (options.action === 'decompose') {
      if (!options.bytes) throw new Error('No document bytes were supplied for decomposition.');
      const fileName = options.fileName ?? request.sourceName ?? 'document.docx';
      const document = await decomposeDocx(options.bytes, fileName);
      output = {
        action: 'decompose',
        fileName,
        markdown: document.markdown,
        bundle: document.bundle,
        paragraphs: document.bundle.stats.paragraphs,
        tables: document.bundle.stats.tables,
        warnings: document.bundle.warnings ?? [],
      };
    } else {
      const bundle = options.bundle;
      if (!bundle) throw new Error('No style bundle is loaded, so Markdown cannot be rebuilt.');
      const markdown = options.markdown ?? request.source;
      // The bundle always carries the inspector's current attributes (KOT-003).
      const merged: KotohaBundle = {
        ...bundle,
        attributes: mergeAttributes(bundle.attributes, options.attributes),
      };
      const result = await rebuildDocx(markdown, merged);
      output = {
        action: 'rebuild',
        fileName: `${baseName(bundle.fileName)}-rebuilt.docx`,
        markdown,
        bundle: merged,
        docx: result.bytes,
        paragraphs: result.paragraphs,
        tables: result.tables,
        warnings: merged.warnings ?? [],
        restoredBlocks: result.restoredBlocks,
        restoredParts: result.restoredParts.length,
        unknownMarkers: result.unknownMarkers,
      };
    }

    const cacheKey = await sha256Hex(
      `${this.id}|${request.mode}|${options.action}|${output.markdown.slice(0, 2000)}|${JSON.stringify(output.bundle.attributes)}`,
    );
    return {
      output,
      providerMode: this.providerMode,
      diagnostics: [],
      elapsedMs: Math.round(performance.now() - started),
      cacheKey,
    };
  }
}

export { decomposeDocx, rebuildDocx, buildSampleDocx };
