/**
 * WO-10 Stage 2 — Kozue (梢絵, UML auto-architect).
 *
 * The model may suggest a relation or a step the static detector could not see.
 * Because a diagram is a machine-readable artifact, the proposal is checked twice:
 *
 * 1. evidence must cite an element that exists in the local diagram (an object,
 *    a participant, a state, a component) — a relation to something that is not
 *    in the diagram is rejected;
 * 2. the Mermaid snippet itself must parse against our own conservative grammar
 *    check: a known diagram header, balanced brackets, and arrow endpoints that
 *    are declared in the snippet or exist in the local diagram.
 *
 * A rejected snippet never reaches `apply`.
 */

import type { KozueOutput, UmlKind } from '../../../tools/kozue/adapter';
import type { AiProposal, EvidenceFacts } from '../mergePolicy';
import { envelopeSchemaFor } from '../mergePolicy';
import { neutralizeActiveContent } from '../sanitize';
import { addSymbol, sourceLines, type ToolHybridSpec } from './types';

export const KOZUE_PROPOSAL_KINDS = ['relation', 'sequence', 'activity', 'diagram', 'naming'] as const;

const HEADERS = [
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'flowchart',
  'graph',
  'componentDiagram',
];

const KEYWORDS = new Set([
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram',
  'stateDiagram-v2',
  'flowchart',
  'graph',
  'participant',
  'actor',
  'class',
  'state',
  'note',
  'over',
  'left',
  'right',
  'of',
  'autonumber',
  'direction',
  'TD',
  'TB',
  'LR',
  'RL',
  'BT',
  'as',
  'end',
  'subgraph',
  'alt',
  'else',
  'opt',
  'loop',
  'par',
  'and',
  'rect',
  'activate',
  'deactivate',
  'title',
  'accTitle',
  'accDescr',
  'component',
  'namespace',
  'style',
  'classDef',
  'linkStyle',
  'click',
]);

const ARROW = /([A-Za-z_][\w]*)\s*(?:-->>|->>|-->|->|--\)|--|==>|-.->|<\|--|\*--|o--)\s*(?:\|[^|]*\|\s*)?([A-Za-z_][\w]*)/;
const BRACKET_ID = /^\s*([A-Za-z_][\w]*)\s*[\[({]/;
const DECLARE = /^\s*(?:participant|actor|class|state|component|namespace)\s+([A-Za-z_][\w]*)/;

export interface MermaidCheck {
  ok: boolean;
  reason?: string;
}

function balanced(text: string): boolean {
  const pairs: Array<[string, string]> = [
    ['[', ']'],
    ['(', ')'],
    ['{', '}'],
  ];
  for (const [open, close] of pairs) {
    let depth = 0;
    for (const character of text) {
      if (character === open) depth += 1;
      if (character === close) depth -= 1;
      if (depth < 0) return false;
    }
    if (depth !== 0) return false;
  }
  return true;
}

/**
 * A conservative grammar check for a proposed fragment. It is deliberately
 * stricter than Mermaid itself: a fragment we cannot verify is not applied.
 */
export function checkMermaidSnippet(
  snippet: string,
  known: Set<string>,
  options: { allowNewDeclarations?: boolean } = {},
): MermaidCheck {
  const text = snippet.trim();
  if (!text) return { ok: false, reason: 'Mermaid の提案が空です。' };
  if (text.length > 4000) return { ok: false, reason: 'Mermaid の提案が長すぎます（4000 文字まで）。' };
  if (text.includes('```')) return { ok: false, reason: 'Mermaid の提案にコードフェンスが含まれています。' };
  if (/<[^>]+>/.test(text)) return { ok: false, reason: 'Mermaid の提案に HTML タグが含まれています。' };

  const rawLines = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('%%'));
  const header = rawLines[0] ?? '';
  if (!HEADERS.some((candidate) => header === candidate || header.startsWith(`${candidate} `))) {
    return { ok: false, reason: `Mermaid の先頭行が図の種類ではありません（${header.slice(0, 40)}）。` };
  }
  if (!balanced(text)) return { ok: false, reason: 'Mermaid の括弧が対応していません。' };

  const declared = new Set<string>(known);
  for (const line of rawLines) {
    const declaration = line.match(DECLARE);
    if (!declaration) continue;
    if (options.allowNewDeclarations === false && !known.has(declaration[1])) {
      return { ok: false, reason: `図に存在しない要素「${declaration[1]}」を新しく宣言しています。` };
    }
    declared.add(declaration[1]);
  }

  for (const line of rawLines.slice(1)) {
    const arrow = line.match(ARROW);
    if (arrow) {
      for (const id of [arrow[1], arrow[2]]) {
        if (KEYWORDS.has(id)) continue;
        if (!declared.has(id)) return { ok: false, reason: `図に存在しない要素「${id}」への関係が含まれています。` };
      }
    }
    const bracket = line.match(BRACKET_ID);
    if (bracket && !KEYWORDS.has(bracket[1]) && !declared.has(bracket[1])) {
      return { ok: false, reason: `図に存在しない要素「${bracket[1]}」が定義されています。` };
    }
    for (const token of line.match(/\{[^}]*\}/g) ?? []) {
      if (!balanced(token)) return { ok: false, reason: 'Mermaid の括弧が対応していません。' };
    }
  }
  return { ok: true };
}

/** Element ids declared by a Mermaid definition (participants, classes, states, nodes). */
export function mermaidIds(mermaid: string): Set<string> {
  const ids = new Set<string>();
  for (const rawLine of mermaid.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%%')) continue;
    const declaration = line.match(DECLARE);
    if (declaration) ids.add(declaration[1]);
    const arrow = line.match(ARROW);
    if (arrow) {
      ids.add(arrow[1]);
      ids.add(arrow[2]);
    }
    const bracket = line.match(BRACKET_ID);
    if (bracket && !KEYWORDS.has(bracket[1])) ids.add(bracket[1]);
    const member = line.match(/^([A-Za-z_][\w]*)\s*:\s*\+?[\w(<]/);
    if (member && !KEYWORDS.has(member[1])) ids.add(member[1]);
  }
  return ids;
}

export const kozueSpec: ToolHybridSpec<'kozue'> = {
  toolId: 'kozue',
  proposalKinds: KOZUE_PROPOSAL_KINDS,
  outputSchema: envelopeSchemaFor(KOZUE_PROPOSAL_KINDS, [
    'LOCAL ANALYSIS lists every element id that exists in the generated diagrams. Never reference an object, participant, state or call that is not listed.',
    'Evidence must name an element id (symbol) and may cite the source line where it appears.',
    'Put a diagram improvement in the "code" field as a Mermaid fragment: the diagram header, then only relations between elements that exist.',
    'Do not use HTML, images, links or code fences inside a Mermaid fragment.',
    'If nothing can be added with evidence, return {"version":1,"summary":"","proposals":[],"notes":[]}.',
  ]),

  describeLocal(output: KozueOutput): string {
    const lines: string[] = [
      `selected diagram: ${output.activeKind} (auto: ${output.autoSelection})`,
      `confidence: ${output.detection.confidence}`,
    ];
    for (const candidate of output.detection.candidates) {
      lines.push(`- candidate ${candidate.kind} score ${candidate.score}: ${candidate.reasons.join('; ')}`);
    }
    for (const kind of Object.keys(output.mermaid) as UmlKind[]) {
      const ids = [...mermaidIds(output.mermaid[kind])].sort();
      lines.push(`elements(${kind}): ${ids.length ? ids.join(', ') : '(none)'}`);
    }
    lines.push('active diagram:');
    lines.push(output.mermaid[output.activeKind]);
    return lines.join('\n');
  },

  facts(output: KozueOutput, sourceName: string, source: string): EvidenceFacts {
    const symbols = new Map<string, number[]>();
    for (const kind of Object.keys(output.mermaid) as UmlKind[]) {
      for (const id of mermaidIds(output.mermaid[kind])) addSymbol(symbols, id);
    }
    return { fileName: sourceName, lines: sourceLines(source), symbols, requireSymbol: true };
  },

  checkProposal(proposal: AiProposal, output: KozueOutput): string | null {
    if (!proposal.code?.trim()) return null;
    const known = mermaidIds(output.mermaid[output.activeKind]);
    const check = checkMermaidSnippet(proposal.code, known, { allowNewDeclarations: false });
    return check.ok ? null : check.reason ?? 'Mermaid の構文を確認できませんでした。';
  },

  apply(output: KozueOutput, accepted: AiProposal[]): KozueOutput {    if (!accepted.length) return output;
    const kind = output.activeKind;
    const block = [
      '',
      '%% AI-assisted supplement (reviewed) — applied as comments; review before merging into the diagram.',
      ...accepted.flatMap((proposal) => [
        `%% [${proposal.kind}] ${neutralizeActiveContent(proposal.title)}`,
        ...neutralizeActiveContent(proposal.detail).split('\n').map((line) => `%% ${line}`),
        ...(proposal.code?.trim() ? proposal.code.split('\n').map((line) => `%% ${line}`) : []),
        ...proposal.evidence.map(
          (entry) => `%% evidence: ${[entry.file ?? output.activeKind, entry.line ? `L${entry.line}` : '', entry.symbol ?? ''].filter(Boolean).join(' · ')}`,
        ),
      ]),
    ].join('\n');
    return { ...output, mermaid: { ...output.mermaid, [kind]: `${output.mermaid[kind]}${block}` } };
  },
};
