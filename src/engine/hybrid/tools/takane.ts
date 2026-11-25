/**
 * WO-10 Stage 2 — Takane (貴音, specification to code).
 *
 * The model may implement a contract the local generator left as a stub, explain
 * how a requirement maps to the code, or flag a guard/error path the generated
 * code does not handle — always tied to a contract that exists in the parsed
 * specification.
 *
 * The proposal is never executed. `apply` writes it into a comment block, so the
 * artifact still compiles, and the operator copies what they decide to use.
 */

import type { TakaneLanguage, TakaneOutput } from '../../../tools/takane/adapter';
import type { AiProposal, EvidenceFacts } from '../mergePolicy';
import { envelopeSchemaFor } from '../mergePolicy';
import { addSymbol, commentedAppendix, sourceLines, type ToolHybridSpec } from './types';

export const TAKANE_PROPOSAL_KINDS = ['implementation', 'requirement-link', 'guard', 'error', 'type'] as const;

export const TAKANE_LANGUAGE_LABEL: Record<TakaneLanguage, string> = {
  python: 'Python 3',
  c: 'C11',
  cpp: 'C++17',
  mcu: 'embedded C (fixed-width integers, static buffers, status codes)',
};

export const takaneSpec: ToolHybridSpec<'takane'> = {
  toolId: 'takane',
  proposalKinds: TAKANE_PROPOSAL_KINDS,
  outputSchema: envelopeSchemaFor(TAKANE_PROPOSAL_KINDS, [
    'LOCAL ANALYSIS lists the contracts, types, guards and error paths parsed from the specification. Cite one of those names; never invent a contract, field or file.',
    'Every proposal must name an existing contract (symbol) and the line in the specification where it is declared.',
    'Put implementation code in the "code" field, in the target language, self-contained, with no placeholder ellipses.',
    'The tool never executes generated code. Do not include shell commands or instructions to run anything.',
    'If nothing can be added with evidence, return {"version":1,"summary":"","proposals":[],"notes":[]}.',
  ]),

  describeLocal(output: TakaneOutput): string {
    const model = output.model;
    const lines: string[] = [
      `target language: ${TAKANE_LANGUAGE_LABEL[output.language] ?? output.language}`,
      `module: ${model.moduleName} · files: ${output.files.map((file) => file.name).join(', ')}`,
      `contracts: ${model.contracts.length} · types: ${model.types.length} · guards: ${model.guards.length} · error paths: ${model.errorPaths.length}`,
      'contracts:',
    ];
    for (const contract of model.contracts.slice(0, 60)) {
      const params = contract.params.map((param) => `${param.name}: ${param.type}${param.optional ? '?' : ''}`).join(', ');
      lines.push(
        `- ${contract.owner ? `${contract.owner}.` : ''}${contract.name}(${params}) -> ${contract.returns}${contract.errors.length ? ` raises ${contract.errors.join(', ')}` : ''}`,
      );
    }
    for (const type of model.types.slice(0, 40)) {
      lines.push(`- ${type.kind} ${type.name}: ${type.fields.map((field) => `${field.name}: ${field.type}`).join(', ')}`);
    }
    for (const guard of model.guards.slice(0, 40)) lines.push(`- guard ${guard.target}: if ${guard.condition} then ${guard.action}`);
    for (const error of model.errorPaths.slice(0, 40)) lines.push(`- error path ${error.target}: ${error.error}`);
    return lines.join('\n');
  },

  facts(output: TakaneOutput, sourceName: string, source: string): EvidenceFacts {
    const symbols = new Map<string, number[]>();
    for (const contract of output.model.contracts) {
      addSymbol(symbols, contract.name);
      if (contract.owner) addSymbol(symbols, `${contract.owner}.${contract.name}`);
    }
    for (const type of output.model.types) addSymbol(symbols, type.name);
    for (const guard of output.model.guards) addSymbol(symbols, guard.target);
    for (const error of output.model.errorPaths) addSymbol(symbols, error.target);
    return { fileName: sourceName, lines: sourceLines(source), symbols };
  },

  apply(output: TakaneOutput, accepted: AiProposal[]): TakaneOutput {
    if (!accepted.length) return output;
    const style = output.language === 'python' ? 'line-hash' : 'line-slash';
    const appendix = commentedAppendix(
      'AI-assisted implementation proposals (reviewed, not executed)',
      accepted,
      `${output.model.moduleName} · ${TAKANE_LANGUAGE_LABEL[output.language] ?? output.language}`,
      style,
    );
    const last = output.files.length - 1;
    const files = output.files.map((file, index) => (index === last ? { ...file, code: `${file.code}${appendix}` } : file));
    const code =
      last >= 0 && output.code === output.files[last].code ? files[last].code : `${output.code}${appendix}`;
    return { ...output, files, code };
  },
};
