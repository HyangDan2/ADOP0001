/**
 * C-FIX-006 (second half) — the data boundary the user actually agreed to.
 *
 * The preview says "lines 40–120 are included, the rest is excluded" and "this tool
 * sends its decomposed Markdown, not the .docx". Those statements are only true if
 * something enforces them on the payload, so this module checks the messages that
 * are about to be sent:
 *
 * - a binary/encoded blob (a base64 `data:` URI, a ZIP/OLE header, NUL bytes) must
 *   never appear — Kotoha's media and style bundle stay in the tab;
 * - text from a source unit the allocation excluded must not appear — the budget's
 *   promise and the payload agree;
 * - a tool that works on decomposed Markdown (Kotoha) must not carry the raw OOXML
 *   style bundle markers.
 *
 * A violation blocks the request in the preflight; it is not a warning, because a
 * warning here would mean the preview described a different payload.
 */

import type { ToolId } from '../../adapters/types';
import type { ChatMessage } from './contracts';
import { HybridError } from './errors';
import { redactText } from './redaction';
import type { SourceSelection } from './budget';

export interface BoundaryViolation {
  id: 'binary-media' | 'excluded-range' | 'tool-scope';
  message: string;
}

export interface BoundaryInput {
  toolId?: ToolId;
  messages: ChatMessage[];
  /** The allocation the preview reported; when given, excluded text is checked. */
  selection?: SourceSelection | null;
  /** Tools whose payload must not contain OOXML bundle markers. */
  ooxmlTools?: ToolId[];
}

const OOXML_MARKERS = ['word/styles.xml', '<w:styles', 'styleBundle', 'word/document.xml'];

function isBinaryLike(text: string): boolean {
  if (/\u0000/.test(text)) return true;
  if (/^PK\u0003\u0004/.test(text)) return true;
  if (/\uFFFD{3,}/.test(text)) return true;
  const base64 = text.match(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]{80,}/g);
  return Boolean(base64?.length);
}

/** Distinctive text of a unit: its first two non-empty lines. */
function signatureOf(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2);
  if (!lines.length) return null;
  const signature = lines.join('\n');
  return signature.length >= 24 ? signature : null;
}

export function inspectDataBoundary(input: BoundaryInput): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const contents = input.messages.map((message) => message.content);
  const joined = contents.join('\n');

  if (contents.some(isBinaryLike)) {
    violations.push({
      id: 'binary-media',
      message: '送信内容にバイナリまたはエンコードされたメディアが含まれています。選択したテキストだけを送信してください。',
    });
  }

  const ooxmlTools = input.ooxmlTools ?? ['kotoha'];
  if (input.toolId && ooxmlTools.includes(input.toolId)) {
    const marker = OOXML_MARKERS.find((entry) => joined.includes(entry));
    if (marker) {
      violations.push({
        id: 'tool-scope',
        message: `このツールは分解済み Markdown のみを送信します（${marker} は送信できません）。`,
      });
    }
  }

  const selection = input.selection;
  if (selection?.truncated && selection.included.length) {
    // Compare against the redacted form: the payload is already redacted, and a
    // secret inside an excluded unit must not be reported as a leak.
    const normalise = (text: string) => redactText(text).text.replace(/\s+/g, ' ').trim();
    const payload = normalise(joined);
    const includedText = normalise(selection.text);
    for (const unit of selection.excluded) {
      const signature = signatureOf(unit.text);
      if (!signature) continue;
      const wanted = normalise(signature);
      if (wanted && payload.includes(wanted) && !includedText.includes(wanted)) {
        violations.push({
          id: 'excluded-range',
          message: `除外したはずの範囲（${unit.startLine}–${unit.endLine} 行）が送信内容に含まれています。`,
        });
        break;
      }
    }
  }

  return violations;
}

/** The send-path form: throws so a caller cannot ignore a violation. */
export function assertDataBoundary(input: BoundaryInput): void {
  const violations = inspectDataBoundary(input);
  if (!violations.length) return;
  throw new HybridError('approval', violations[0].message);
}
