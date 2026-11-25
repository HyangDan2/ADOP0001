import type { Lang, SourceDiagnostic } from './types';

/**
 * Two-pass structural mask (ANA-001). Masking never changes length or line
 * breaks, so every reported line maps back to the original source.
 */

export interface Masked {
  /** Comments removed, string literals kept verbatim. */
  noComment: string;
  /** Comments removed and string bodies blanked. */
  code: string;
  diagnostics: SourceDiagnostic[];
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

/** `/regex/` vs division: a regex may start after an operator, not after a value. */
function looksLikeRegexStart(previous: string): boolean {
  if (!previous) return true;
  return '=(,:;[!&|?{};+-*%~^<>'.includes(previous);
}

export function maskSource(source: string, lang: Lang): Masked {
  const noComment = source.split('');
  const code = source.split('');
  const diagnostics: SourceDiagnostic[] = [];
  const length = source.length;

  const blank = (target: string[], from: number, to: number, keepDelimiters = false) => {
    for (let k = from; k < to && k < length; k += 1) {
      if (target[k] === '\n') continue;
      if (keepDelimiters && (k === from || k === to - 1)) continue;
      target[k] = ' ';
    }
  };
  const blankBoth = (from: number, to: number) => {
    blank(noComment, from, to);
    blank(code, from, to);
  };

  let i = 0;
  let previous = '';
  while (i < length) {
    const ch = source[i];
    const next = source[i + 1];

    if (lang !== 'python' && ch === '/' && next === '/') {
      const start = i;
      while (i < length && source[i] !== '\n') i += 1;
      blankBoth(start, i);
      continue;
    }
    if (lang !== 'python' && ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      const closed = i < length;
      if (!closed) {
        diagnostics.push({
          code: 'unterminated-comment',
          severity: 'warn',
          message: 'Block comment is never closed; the rest of the file was treated as comment.',
          line: lineAt(source, start),
        });
      }
      i = Math.min(length, i + 2);
      blankBoth(start, i);
      continue;
    }
    if (lang === 'python' && ch === '#') {
      const start = i;
      while (i < length && source[i] !== '\n') i += 1;
      blankBoth(start, i);
      continue;
    }

    const pythonTriple =
      lang === 'python' && (ch === '"' || ch === "'") && next === ch && source[i + 2] === ch;
    if (pythonTriple) {
      const start = i;
      i += 3;
      while (i < length && !(source[i] === ch && source[i + 1] === ch && source[i + 2] === ch)) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      const closed = i < length;
      if (!closed) {
        diagnostics.push({
          code: 'unterminated-string',
          severity: 'warn',
          message: 'A triple-quoted string is never closed.',
          line: lineAt(source, start),
        });
      }
      i = Math.min(length, i + 3);
      // A docstring is structure noise, but its text is still the module's prose:
      // only the structural mask is blanked.
      blank(code, start, i);
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const template = ch === '`';
      const rawGoString = lang === 'go' && template;
      const start = i;
      i += 1;
      let closed = false;
      while (i < length) {
        const c = source[i];
        if (c === '\\' && !rawGoString) {
          i += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          i += 1;
          break;
        }
        if (!template && c === '\n') break;
        i += 1;
      }
      // `noComment` keeps the literal (a default value or an error message is part
      // of the contract); only the structural mask hides it.
      blank(code, start + 1, closed ? i - 1 : i);
      if (!closed) {
        diagnostics.push({
          code: 'unterminated-string',
          severity: 'warn',
          message: 'A string literal is never closed on its line.',
          line: lineAt(source, start),
        });
      }
      previous = '"';
      continue;
    }

    if ((lang === 'typescript' || lang === 'javascript') && ch === '/' && looksLikeRegexStart(previous)) {
      const start = i;
      i += 1;
      let inClass = false;
      let closed = false;
      while (i < length && source[i] !== '\n') {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (closed) {
        blank(code, start + 1, i - 1);
        previous = '/';
        continue;
      }
      i = start + 1;
    }

    if (!/\s/.test(ch)) previous = ch;
    i += 1;
  }

  return { noComment: noComment.join(''), code: code.join(''), diagnostics };
}
