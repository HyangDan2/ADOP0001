/**
 * Kotoha (琴葉) engine adapter — docx decompose, markdown rebuild, sample generation.
 */

import type { EngineAdapter, EngineRequest, EngineResult, ProviderMode } from '../../adapters/types';
import { baseName, sha256Hex } from '../../lib/util';
import type { BundleAttributes, KotohaBundle } from './bundle';
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
}

export class KotohaAdapter implements EngineAdapter<KotohaOutput, KotohaOptions> {
  readonly id = 'kotoha' as const;
  readonly title = 'Docx ↔ MD Round-Trip';
  readonly japaneseTitle = '琴葉';
  readonly providerMode: ProviderMode = 'local-static';
  readonly capabilities = [
    'OOXML document.xml to Markdown with styles, lists, tables, links and media',
    'Style bundle (.kotoha.json + IndexedDB) for styles, theme, numbering, headers, footers, margins',
    'Style & Attribute Inspector with editable fonts, size, spacing, margins and heading colours',
    'Markdown rebuild into a valid .docx that keeps the original look',
    'One-click sample .docx generation',
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
      };
    } else {
      const bundle = options.bundle;
      if (!bundle) throw new Error('No style bundle is loaded, so Markdown cannot be rebuilt.');
      const markdown = options.markdown ?? request.source;
      const merged: KotohaBundle = {
        ...bundle,
        attributes: { ...bundle.attributes, ...(options.attributes ?? {}) },
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
