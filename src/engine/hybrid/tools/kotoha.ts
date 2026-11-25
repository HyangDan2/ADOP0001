/**
 * WO-10 Stage 2 — Kotoha (琴葉, DOCX ↔ Markdown round trip).
 *
 * The privacy rule is structural here: the only text this spec can describe or
 * send is the Markdown the operator is editing. The DOCX package, the style
 * bundle and every embedded image stay in the browser — `describeLocal` reads
 * neither `bundle` bytes nor `docx` bytes, and `checkProposal` refuses a proposal
 * that carries a data URI or an inline image.
 *
 * What the model may add: structure (a heading that is missing), wording, a
 * technical explanation, consistency between sections. The bundle is untouched,
 * so a rebuild keeps the original styles.
 */

import type { KotohaOutput } from '../../../tools/kotoha/adapter';
import type { AiProposal, EvidenceFacts } from '../mergePolicy';
import { envelopeSchemaFor } from '../mergePolicy';
import { addSymbol, markdownAppendix, sourceLines, type ToolHybridSpec } from './types';

export const KOTOHA_PROPOSAL_KINDS = ['structure', 'wording', 'technical', 'consistency'] as const;

const BINARY_MARKERS = [/data:image\//i, /data:application\//i, /base64,[A-Za-z0-9+/=]{200,}/, /\u0000/];

export const kotohaSpec: ToolHybridSpec<'kotoha'> = {
  toolId: 'kotoha',
  proposalKinds: KOTOHA_PROPOSAL_KINDS,
  outputSchema: envelopeSchemaFor(KOTOHA_PROPOSAL_KINDS, [
    'You receive the Markdown the operator selected. You never receive the DOCX package, its styles or its images, and you must not ask for them.',
    'Every proposal must cite an existing heading text (symbol) and the line it appears on.',
    'Propose edits as Markdown text in the "detail" field (and "code" when a whole replacement block is clearer). Do not include images, data URIs or binary data.',
    'Styles, fonts and the original container are restored by the tool; do not propose style markup.',
    'If nothing can be added with evidence, return {"version":1,"summary":"","proposals":[],"notes":[]}.',
  ]),

  describeLocal(output: KotohaOutput): string {
    const lines: string[] = [
      `file: ${output.fileName}`,
      `paragraphs: ${output.paragraphs ?? 'unknown'} · tables: ${output.tables ?? 'unknown'} · preserved blocks: ${output.bundle.preservedBlocks ? Object.keys(output.bundle.preservedBlocks).length : 0}`,
      `markdown characters: ${output.markdown.length}`,
    ];
    const headings = output.markdown
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => /^#{1,6}\s+/.test(entry.line.trim()));
    lines.push('headings:');
    for (const heading of headings.slice(0, 60)) {
      lines.push(`- L${heading.number}: ${heading.line.trim()}`);
    }
    if (output.warnings.length) {
      lines.push('conversion warnings (local facts):');
      for (const warning of output.warnings.slice(0, 20)) lines.push(`- ${warning.code}: ${warning.labelJa} ×${warning.count}`);
    }
    return lines.join('\n');
  },

  facts(_output: KotohaOutput, sourceName: string, source: string): EvidenceFacts {
    const lines = sourceLines(source);
    const symbols = new Map<string, number[]>();
    lines.forEach((line, index) => {
      const heading = line.trim().match(/^#{1,6}\s+(.+)$/);
      if (heading) addSymbol(symbols, heading[1].trim(), index + 1);
    });
    return { fileName: sourceName, lines, symbols };
  },

  checkProposal(proposal: AiProposal): string | null {
    const text = `${proposal.detail}\n${proposal.code ?? ''}`;
    if (BINARY_MARKERS.some((marker) => marker.test(text))) {
      return '提案に画像・データ URI・バイナリが含まれているため拒否しました。';
    }
    return null;
  },

  apply(output: KotohaOutput, accepted: AiProposal[]): KotohaOutput {
    if (!accepted.length) return output;
    // The bundle (styles, numbering, headers) is carried over untouched, so a
    // rebuild still restores the original look.
    return {
      ...output,
      markdown: `${output.markdown}${markdownAppendix('AI-assisted document notes (reviewed)', accepted, output.fileName)}`,
    };
  },
};
