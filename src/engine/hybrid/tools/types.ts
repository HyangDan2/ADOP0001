/**
 * WO-10 — one hybrid spec per tool.
 *
 * A tool spec is the whole contract between a deterministic tool and the AI
 * supplement:
 *
 * - `outputSchema` is the exact JSON shape the model must return (a single
 *   free-text answer is never inserted into an artifact);
 * - `describeLocal` is the compact, deterministic fact sheet sent as
 *   LOCAL ANALYSIS — the only material the model may cite;
 * - `facts` turns the same result into the index evidence is checked against
 *   (symbols, their lines, the file name);
 * - `apply` is the only function that ever writes AI text into an artifact, and
 *   it runs only on proposals the user accepted.
 */

import type { ToolId } from '../../../adapters/types';
import type { ToolOutput } from '../../core/contracts';
import type { AiProposal, EvidenceFacts } from '../mergePolicy';

export interface ToolHybridSpec<K extends ToolId> {
  readonly toolId: K;
  /** The proposal kinds this tool accepts; anything else fails the schema. */
  readonly proposalKinds: readonly string[];
  /** JSON shape + tool rules, placed in the system message. */
  readonly outputSchema: string;
  /** Target language for few-shot matching (Takane: python | c | cpp | mcu). */
  readonly targetLanguage?: string;
  /** Compact deterministic facts for LOCAL ANALYSIS. */
  describeLocal(output: ToolOutput<K>): string;
  /** The declarations evidence may cite. */
  facts(output: ToolOutput<K>, sourceName: string, source: string): EvidenceFacts;
  /**
   * Merges accepted proposals into a new artifact. It must not remove or rewrite
   * a local fact; AI text goes into a clearly labelled, appended section.
   */
  apply(output: ToolOutput<K>, accepted: AiProposal[]): ToolOutput<K>;
  /**
   * A tool-specific check beyond evidence. Returning a message rejects the
   * proposal (Kozue: Mermaid grammar; Kotoha: no binary payloads).
   */
  checkProposal?(proposal: AiProposal, output: ToolOutput<K>): string | null;
}

/** Every line of the analysed source, used for line-range and quote checks. */
export function sourceLines(source: string): string[] {
  return source.split('\n');
}

/** Adds a symbol and the lines it owns. A symbol with no line is still citable. */
export function addSymbol(symbols: Map<string, number[]>, name: string | undefined | null, line?: number): void {
  const key = (name ?? '').trim();
  if (!key) return;
  const owned = symbols.get(key) ?? [];
  if (typeof line === 'number' && line > 0 && !owned.includes(line)) owned.push(line);
  symbols.set(key, owned);
  // A qualified name (`Service.pay`) is also citable by its bare name.
  const bare = key.includes('.') ? key.split('.').pop() ?? '' : key.includes('::') ? key.split('::').pop() ?? '' : '';
  if (bare && bare !== key) addSymbol(symbols, bare, line);
}

/** True when the value is a non-empty string. */
export function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export interface EvidenceLine {
  file?: string;
  line?: number;
  symbol?: string;
  quote?: string;
}

/** Renders the evidence of a proposal as the human-readable citation list. */
export function evidenceBullets(proposal: AiProposal, fileName: string): string[] {
  return proposal.evidence.map((entry) => {
    const where = [entry.file ?? fileName, entry.line ? `L${entry.line}` : null, entry.symbol ?? null]
      .filter(Boolean)
      .join(' · ');
    return entry.quote ? `- \`${where}\` — “${entry.quote}”` : `- \`${where}\``;
  });
}

/** The Markdown section appended to a text artifact when proposals are accepted. */
export function markdownAppendix(title: string, proposals: AiProposal[], fileName: string): string {
  const lines: string[] = [
    '',
    '---',
    '',
    `## ${title}`,
    '',
    '> AI-assisted supplement, applied after operator review. Local static analysis remains the source of truth; these notes are interpretations, not verified facts.',
    '',
  ];
  for (const proposal of proposals) {
    lines.push(`### ${proposal.title}`, '');
    lines.push(proposal.detail.trim(), '');
    if (proposal.rationale?.trim()) lines.push(`> AI interpretation: ${proposal.rationale.trim()}`, '');
    lines.push('Evidence:', '');
    lines.push(...evidenceBullets(proposal, fileName), '');
  }
  return lines.join('\n');
}

export type CommentStyle = 'line-slash' | 'line-hash' | 'html';

export function commentStyleFor(language: string | undefined): CommentStyle {
  switch (language) {
    case 'python':
    case 'pytest':
      return 'line-hash';
    case 'markdown':
      return 'html';
    default:
      return 'line-slash';
  }
}

function commentLine(style: CommentStyle, text: string): string {
  if (style === 'line-hash') return text ? `# ${text}` : '#';
  if (style === 'html') return `<!-- ${text} -->`;
  return text ? `// ${text}` : '//';
}

/**
 * A commented appendix: the artifact still compiles/renders, and the reviewed
 * suggestion is right there to copy. Generated code is never executed.
 */
export function commentedAppendix(title: string, proposals: AiProposal[], fileName: string, style: CommentStyle): string {
  const lines: string[] = ['', commentLine(style, '='.repeat(60)), commentLine(style, title)];
  lines.push(commentLine(style, 'Applied after operator review. Not executed by ADOP0001.'));
  for (const proposal of proposals) {
    lines.push(commentLine(style, '-'.repeat(50)));
    lines.push(commentLine(style, `${proposal.title} [${proposal.kind}]`));
    for (const bullet of evidenceBullets(proposal, fileName)) lines.push(commentLine(style, bullet.replace(/^- /, '')));
    if (proposal.rationale?.trim()) lines.push(commentLine(style, `AI interpretation: ${proposal.rationale.trim()}`));
    for (const line of proposal.detail.split('\n')) lines.push(commentLine(style, line));
    if (proposal.code?.trim()) {
      lines.push(commentLine(style, 'proposed code:'));
      for (const line of proposal.code.split('\n')) lines.push(commentLine(style, line));
    }
  }
  lines.push(commentLine(style, '='.repeat(60)), '');
  return lines.join('\n');
}
