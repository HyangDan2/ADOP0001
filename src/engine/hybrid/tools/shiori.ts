/**
 * WO-10 Stage 1 (pilot) — Shiori (枝織, specification writer).
 *
 * What the model may add: the *meaning* of a contract the parser found — design
 * intent, a missing requirement, an error-handling note, a clarification of the
 * published contract — always cited to a contract or guard that exists.
 *
 * What it may not add: a function, class, file or line that the local model does
 * not contain. The parser found 12 contracts; a thirteenth is a hallucination.
 */

import type { ShioriOutput } from '../../../tools/shiori/adapter';
import { escapeHtml } from '../../../lib/util';
import type { AiProposal, EvidenceFacts } from '../mergePolicy';
import { envelopeSchemaFor } from '../mergePolicy';
import {
  addSymbol,
  markdownAppendix,
  sourceLines,
  type ToolHybridSpec,
} from './types';

export const SHIORI_PROPOSAL_KINDS = ['intent', 'requirements', 'error-handling', 'contract', 'design'] as const;

export const shioriSpec: ToolHybridSpec<'shiori'> = {
  toolId: 'shiori',
  proposalKinds: SHIORI_PROPOSAL_KINDS,
  outputSchema: envelopeSchemaFor(SHIORI_PROPOSAL_KINDS, [
    'LOCAL ANALYSIS already contains every contract, guard, error path and type the parser found. Never restate one with different content.',
    'Every proposal must cite an existing symbol and the line it is declared on.',
    'Never invent a function, class, file, parameter or return type.',
    'The detail field is prose for the specification; do not paste the source back.',
    'If nothing can be added with evidence, return {"version":1,"summary":"","proposals":[],"notes":[]}.',
  ]),

  describeLocal(output: ShioriOutput): string {
    const model = output.model;
    const lines: string[] = [
      `file: ${model.fileName}`,
      `language: ${model.language}`,
      `contracts: ${model.contracts.length} · behaviour rules: ${model.guardCount} · error paths: ${model.errorCount} · types: ${model.typeCount}`,
      'contracts:',
    ];
    for (const contract of model.contracts) {
      const errors = contract.errors.length ? ` may raise ${contract.errors.join(', ')}` : ' no raised errors';
      lines.push(
        `- ${contract.name} (L${contract.line}) ${contract.visibility}${contract.async ? ' async' : ''} returns ${contract.returns}${errors}`,
      );
    }
    if (model.rules.length) {
      lines.push('guards:');
      for (const rule of model.rules.slice(0, 60)) {
        lines.push(`- ${rule.function} (L${rule.line}) if ${rule.condition} then ${rule.action}`);
      }
    }
    if (model.errors.length) {
      lines.push('error paths:');
      for (const error of model.errors.slice(0, 40)) {
        lines.push(`- ${error.function} (L${error.line}) ${error.error}${error.message ? `: ${error.message}` : ''}`);
      }
    }
    if (model.types.length) {
      lines.push('types:');
      for (const type of model.types.slice(0, 40)) lines.push(`- ${type.kind} ${type.name}${type.extends ? ` extends ${type.extends}` : ''}`);
    }
    if (model.dependencies.length) {
      lines.push('dependencies:');
      for (const dependency of model.dependencies.slice(0, 40)) {
        lines.push(`- ${dependency.module} (${dependency.external ? 'external' : 'local'}, L${dependency.line})`);
      }
    }
    return lines.join('\n');
  },

  facts(output: ShioriOutput, sourceName: string, source: string): EvidenceFacts {
    const symbols = new Map<string, number[]>();
    for (const contract of output.model.contracts) addSymbol(symbols, contract.name, contract.line);
    for (const rule of output.model.rules) addSymbol(symbols, rule.function, rule.line);
    for (const error of output.model.errors) addSymbol(symbols, error.function, error.line);
    for (const type of output.model.types) addSymbol(symbols, type.name);
    for (const dependency of output.model.dependencies) addSymbol(symbols, dependency.module, dependency.line);
    return { fileName: sourceName, lines: sourceLines(source), symbols };
  },

  apply(output: ShioriOutput, accepted: AiProposal[]): ShioriOutput {
    if (!accepted.length) return output;
    const markdown = `${output.markdown}${markdownAppendix('AI-assisted supplement (reviewed)', accepted, output.model.fileName)}`;
    // The HTML is the artifact of the sections the user selected, so the appendix
    // is inserted into it instead of regenerating from a different section list.
    const htmlBlock = [
      '<section class="ai-supplement">',
      '<h2>AI-assisted supplement (reviewed)</h2>',
      '<p><em>AI-assisted notes, applied after operator review. Local static analysis remains the source of truth.</em></p>',
      ...accepted.map((proposal) =>
        [
          `<h3>${escapeHtml(proposal.title)} <small>[${escapeHtml(proposal.kind)}]</small></h3>`,
          `<p>${escapeHtml(proposal.detail)}</p>`,
          proposal.rationale ? `<blockquote>AI interpretation: ${escapeHtml(proposal.rationale)}</blockquote>` : '',
          `<ul>${proposal.evidence
            .map(
              (entry) =>
                `<li><code>${escapeHtml([entry.file ?? output.model.fileName, entry.line ? `L${entry.line}` : '', entry.symbol ?? ''].filter(Boolean).join(' · '))}</code>${
                  entry.quote ? ` — “${escapeHtml(entry.quote)}”` : ''
                }</li>`,
            )
            .join('')}</ul>`,
        ].join(''),
      ),
      '</section>',
    ].join('\n');
    const html = output.html.includes('</main>')
      ? output.html.replace('</main>', `${htmlBlock}\n</main>`)
      : `${output.html}\n${htmlBlock}`;
    return { ...output, markdown, html };
  },
};
