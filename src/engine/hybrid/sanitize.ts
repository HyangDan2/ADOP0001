/**
 * WO-12 — what an AI answer may never bring into the page.
 *
 * A model answer is data written by a third party. Two things are true at once:
 * the answer is shown to the operator for review, and it never runs.
 *
 * - Text fields (title, detail, rationale) are checked before a proposal is
 *   offered: a script tag, an inline event handler, an `iframe`/`object`/`form`,
 *   a `javascript:` or `data:text/html` URL, or a `<style>` block rejects the
 *   proposal with a reason the operator can read.
 * - Any HTML built from AI text goes through `sanitizeAiHtml` first, which
 *   removes the elements and attributes above and makes links inert
 *   (`href`/`src` dropped, `rel` kept). Nothing auto-navigates, auto-loads or
 *   auto-submits.
 * - Code a model proposes is never executed anywhere in this app; it is added
 *   to an artifact as a comment, and the UI shows it inside a `<pre>`.
 */

/** A name plus the pattern that found it, for the rejection message. */
export interface ActiveContentFinding {
  name: string;
  sample: string;
}

const ACTIVE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'script', pattern: /<\s*script\b[^>]*>/i },
  { name: 'script-close', pattern: /<\s*\/\s*script\s*>/i },
  { name: 'iframe', pattern: /<\s*iframe\b/i },
  { name: 'object', pattern: /<\s*object\b/i },
  { name: 'embed', pattern: /<\s*embed\b/i },
  { name: 'style', pattern: /<\s*style\b/i },
  { name: 'link', pattern: /<\s*link\b/i },
  { name: 'meta', pattern: /<\s*meta\b/i },
  { name: 'base', pattern: /<\s*base\b/i },
  { name: 'form', pattern: /<\s*form\b/i },
  { name: 'event-handler', pattern: /\son[a-z]{3,}\s*=/i },
  { name: 'javascript-url', pattern: /javascript\s*:/i },
  { name: 'data-html', pattern: /data\s*:\s*text\/html/i },
  { name: 'css-expression', pattern: /expression\s*\(/i },
  { name: 'svg-script', pattern: /<\s*svg\b[\s\S]{0,400}?<\s*script\b/i },
];

/** Every active-content pattern found in the text (empty = inert). */
export function findActiveContent(text: string): ActiveContentFinding[] {
  if (!text) return [];
  const findings: ActiveContentFinding[] = [];
  for (const { name, pattern } of ACTIVE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) findings.push({ name, sample: match[0].slice(0, 60) });
  }
  return findings;
}

export function containsActiveContent(text: string): boolean {
  return findActiveContent(text).length > 0;
}

/** Japanese sentence naming what was found; used in the rejected-proposal list. */
export function describeActiveContent(findings: ActiveContentFinding[]): string {
  const names = Array.from(new Set(findings.map((finding) => finding.name))).join('、');
  return `AI の文面に実行可能な内容（${names}）が含まれていたため、この提案は採用しませんでした。`;
}

/**
 * Removes active content from a fragment. Text that survives is kept; markup
 * that could run or fetch is removed, and links keep their label but lose
 * `href`/`src` so nothing is opened by the app itself.
 */
export function sanitizeAiHtml(html: string): string {
  if (!html) return '';
  let output = html;
  // Whole elements first, so their inner text cannot leave a stray tag behind.
  output = output.replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, '');
  output = output.replace(/<\s*style\b[\s\S]*?<\s*\/\s*style\s*>/gi, '');
  output = output.replace(/<\s*(iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  // Self-closing / void elements.
  output = output.replace(/<\s*(script|iframe|object|embed|link|meta|base|form|input|button|textarea|select)\b[^>]*>/gi, '');
  // Inline event handlers (`onclick=`, `onerror=` …).
  output = output.replace(/\son[a-z]{3,}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // URL-bearing attributes that could run or fetch.
  output = output.replace(/\s(href|src|srcset|action|formaction|poster|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // A scheme left in plain text (`javascript:alert(1)`) is defused too.
  output = output.replace(/javascript\s*:/gi, 'javascript&#58;');
  output = output.replace(/data\s*:\s*text\/html/gi, 'data&#58;text/html');
  return output;
}

/**
 * Neutralizes active content inside plain text that will be embedded in a
 * Markdown or code artifact. Markdown passes HTML through in many renderers, so
 * the same elements are removed here; the remaining text is unchanged.
 */
export function neutralizeActiveContent(text: string): string {
  if (!text) return '';
  if (!containsActiveContent(text)) return text;
  let output = text;
  output = output.replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, '');
  output = output.replace(/<\s*(iframe|object|embed|noscript|template|style|svg|math|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  output = output.replace(/<\s*(script|iframe|object|embed|link|meta|base|form|input|button|textarea|select)\b[^>]*>/gi, '');
  output = output.replace(/\son[a-z]{3,}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  output = output.replace(/javascript\s*:/gi, 'javascript: ');
  output = output.replace(/data\s*:\s*text\/html/gi, 'data: text/html');
  return output;
}

/** True when a string looks like it would load or run something if rendered. */
export function isInertArtifactText(text: string): boolean {
  return !containsActiveContent(text);
}
