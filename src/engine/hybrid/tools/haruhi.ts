/**
 * WO-10 Stage 1 (pilot) — Haruhi (春日, test case forge).
 *
 * The local engine already derives one case per signature, guard, boundary and
 * error path. The model may propose what a static derivation cannot see:
 * additional boundary/negative/exception candidates, a test the framework can
 * express, or an area the checklist left unmapped — each cited to a function and
 * a line that exist.
 *
 * The generated test code is never run by ADOP0001, before or after a proposal.
 */

import type { HaruhiOutput } from '../../../tools/haruhi/adapter';
import type { AiProposal, EvidenceFacts } from '../mergePolicy';
import { envelopeSchemaFor } from '../mergePolicy';
import { addSymbol, commentedAppendix, sourceLines, type ToolHybridSpec } from './types';

export const HARUHI_PROPOSAL_KINDS = [
  'boundary',
  'negative',
  'exception',
  'branch',
  'missing-area',
  'test-code',
] as const;

export const haruhiSpec: ToolHybridSpec<'haruhi'> = {
  toolId: 'haruhi',
  proposalKinds: HARUHI_PROPOSAL_KINDS,
  outputSchema: envelopeSchemaFor(HARUHI_PROPOSAL_KINDS, [
    'LOCAL ANALYSIS lists the cases and branches the local engine already covers. Do not repeat a case that exists; propose what is missing.',
    'Every proposal must cite a function name and the line where it is declared.',
    'Never invent a function, class, module or import.',
    'For a test-code proposal, put the code in the "code" field in the target framework and keep it self-contained.',
    'Generated code is offered to the operator and is never executed by the tool.',
    'If nothing can be added with evidence, return {"version":1,"summary":"","proposals":[],"notes":[]}.',
  ]),

  describeLocal(output: HaruhiOutput): string {
    const byKind = new Map<string, number>();
    for (const item of output.cases) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    const lines: string[] = [
      `output file: ${output.fileName}`,
      `cases: ${output.cases.length} (${[...byKind.entries()].map(([kind, count]) => `${kind}=${count}`).join(', ') || 'none'})`,
      `static branch mapping: ${output.staticMapping.mapped}/${output.staticMapping.mapped + output.staticMapping.unmapped} · unsupported ${output.staticMapping.unsupported}`,
      'cases:',
    ];
    for (const item of output.cases.slice(0, 80)) {
      lines.push(
        `- ${item.id} [${item.kind}] ${item.fn.name}${item.sourceLine ? ` (L${item.sourceLine})` : ''} — ${item.title} [${item.status}]`,
      );
    }
    if (output.checklist.length) {
      lines.push('branches:');
      for (const branch of output.checklist.slice(0, 80)) {
        lines.push(`- ${branch.function} (L${branch.line}) ${branch.branch} → ${branch.status}${branch.reason ? ` (${branch.reason})` : ''}`);
      }
    }
    if (output.blockedInstances.length) lines.push(`fixtures needed: ${output.blockedInstances.join(', ')}`);
    return lines.join('\n');
  },

  facts(output: HaruhiOutput, sourceName: string, source: string): EvidenceFacts {
    const symbols = new Map<string, number[]>();
    for (const item of output.cases) {
      addSymbol(symbols, item.fn.name, item.sourceLine ?? item.fn.startLine);
      addSymbol(symbols, item.fn.className ? `${item.fn.className}.${item.fn.name}` : undefined, item.sourceLine ?? item.fn.startLine);
      addSymbol(symbols, item.id, item.sourceLine);
    }
    for (const branch of output.checklist) addSymbol(symbols, branch.function, branch.line);
    return { fileName: sourceName, lines: sourceLines(source), symbols };
  },

  apply(output: HaruhiOutput, accepted: AiProposal[]): HaruhiOutput {
    if (!accepted.length) return output;
    const style = output.fileName.endsWith('.py') ? 'line-hash' : 'line-slash';
    return {
      ...output,
      code: `${output.code}${commentedAppendix('AI-suggested tests (reviewed, not executed)', accepted, output.fileName, style)}`,
    };
  },
};
