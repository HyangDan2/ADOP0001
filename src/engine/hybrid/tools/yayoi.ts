/**
 * WO-10 Stage 2 — Yayoi (弥生, pseudocode studio).
 *
 * The model explains what the stripped pseudocode cannot say by itself: the
 * meaning of a complex algorithm, what a processing step is for, and how the
 * pseudocode itself could read better. It cannot add a statement that the source
 * does not contain, and every proposal cites a block and line.
 */

import type { YayoiOutput } from '../../../tools/yayoi/adapter';
import type { AiProposal, EvidenceFacts } from '../mergePolicy';
import { envelopeSchemaFor } from '../mergePolicy';
import { addSymbol, markdownAppendix, sourceLines, type ToolHybridSpec } from './types';

export const YAYOI_PROPOSAL_KINDS = ['algorithm', 'flow', 'pseudocode', 'naming'] as const;

export const yayoiSpec: ToolHybridSpec<'yayoi'> = {
  toolId: 'yayoi',
  proposalKinds: YAYOI_PROPOSAL_KINDS,
  outputSchema: envelopeSchemaFor(YAYOI_PROPOSAL_KINDS, [
    'LOCAL ANALYSIS lists the pseudocode blocks the local engine produced. Never invent a block, statement or variable.',
    'Every proposal must cite an existing block name and the source line it starts on.',
    'When you propose improved pseudocode, put it in the "code" field as plain pseudocode lines (no markdown fence).',
    'Explain meaning; do not restate the pseudocode verbatim.',
    'If nothing can be added with evidence, return {"version":1,"summary":"","proposals":[],"notes":[]}.',
  ]),

  describeLocal(output: YayoiOutput): string {
    const lines: string[] = [
      `functions: ${output.stats.functions} · statements: ${output.stats.statements} · kept: ${output.stats.kept}`,
    ];
    for (const block of output.blocks.slice(0, 40)) {
      lines.push(`block ${block.function} (L${block.sourceStart}-L${block.sourceEnd}) ${block.signature}`);
      for (const line of block.lines.slice(0, 40)) {
        if (line.sourceLine === null) continue;
        lines.push(`  L${line.sourceLine}: ${line.text}`);
      }
    }
    return lines.join('\n');
  },

  facts(output: YayoiOutput, sourceName: string, source: string): EvidenceFacts {
    const symbols = new Map<string, number[]>();
    for (const block of output.blocks) addSymbol(symbols, block.function, block.sourceStart);
    return { fileName: sourceName, lines: sourceLines(source), symbols };
  },

  apply(output: YayoiOutput, accepted: AiProposal[]): YayoiOutput {
    if (!accepted.length) return output;
    const markdown = `${output.markdown}${markdownAppendix('AI-assisted explanation (reviewed)', accepted, 'pseudocode')}`;
    return { ...output, markdown };
  },
};
