/**
 * WO-12 — an AI answer is data, never code.
 *
 * Three layers are pinned here: what is refused before a proposal is offered,
 * what is removed when AI text is built into HTML, and the fact that no module
 * in this app can execute a generated snippet.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  containsActiveContent,
  describeActiveContent,
  findActiveContent,
  neutralizeActiveContent,
  sanitizeAiHtml,
} from '../src/engine/hybrid/sanitize';
import { shioriSpec } from '../src/engine/hybrid/tools/shiori';
import { runHybridPass } from '../src/engine/hybrid/orchestrator';
import { runEngine } from '../src/engine/core/runner';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { MockHybridProvider } from '../src/engine/hybrid/mock';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';
import type { AiProposal } from '../src/engine/hybrid/mergePolicy';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SOURCE = [
  'export function charge(amount: number): boolean {',
  '  if (amount <= 0) throw new Error("amount must be positive");',
  '  return true;',
  '}',
  '',
].join('\n');

const settings: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
};

const ACTIVE_SAMPLES = [
  '<script>alert(1)</script>',
  '<iframe src="https://evil.example"></iframe>',
  '<img src=x onerror="alert(1)">',
  '<style>body{display:none}</style>',
  '<form action="https://evil.example"><input></form>',
  'click <a href="javascript:alert(1)">here</a>',
  '<img src="data:text/html,<script>alert(1)</script>">',
  '<svg onload=alert(1)></svg>',
];

describe('active content detection', () => {
  it.each(ACTIVE_SAMPLES)('flags %s', (sample) => {
    expect(containsActiveContent(sample)).toBe(true);
    expect(findActiveContent(sample).length).toBeGreaterThan(0);
  });

  it('leaves ordinary prose and code-like text alone', () => {
    const benign = [
      'The guard rejects a non-positive amount before charging.',
      'if (amount <= 0) throw new Error("amount must be positive")',
      'Use `a < b` to compare, and `x => y` for a mapping.',
      'Returns true when the invoice is settled.',
    ];
    for (const text of benign) {
      expect(containsActiveContent(text), text).toBe(false);
      expect(neutralizeActiveContent(text)).toBe(text);
    }
  });

  it('names what it found, for the rejection list', () => {
    const message = describeActiveContent(findActiveContent('<script>alert(1)</script>'));
    expect(message).toContain('script');
    expect(message).toContain('採用しませんでした');
  });
});

describe('HTML sanitization', () => {
  it('removes elements and attributes that run or fetch', () => {
    const dirty = [
      '<section>',
      '<script>window.x = 1</script>',
      '<h3>Title</h3>',
      '<p>Body</p>',
      '<img src="https://evil.example/pixel.png" onerror="alert(1)">',
      '<a href="https://evil.example" onclick="alert(2)">link</a>',
      '<iframe src="https://evil.example"></iframe>',
      '</section>',
    ].join('');
    const clean = sanitizeAiHtml(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('href=');
    expect(clean).not.toContain('src=');
    expect(clean).not.toContain('<iframe');
    expect(clean).not.toContain('evil.example');
    // The prose survives; only the active part is gone.
    expect(clean).toContain('<h3>Title</h3>');
    expect(clean).toContain('Body');
    expect(clean).toContain('link');
  });

  it('defuses a scheme that is left as plain text', () => {
    const clean = sanitizeAiHtml('<p>javascript:alert(1)</p>');
    expect(clean).not.toMatch(/javascript\s*:/i);
  });

  it('keeps AI text in an artifact inert even when the proposal was built by hand', () => {
    const output = {
      markdown: '# Spec',
      html: '<main><h1>Spec</h1></main>',
      model: { fileName: 'charge.ts', contracts: [], rules: [], errors: [], types: [], dependencies: [], guardCount: 0, errorCount: 0, typeCount: 0, language: 'typescript' },
    } as never;
    const proposal: AiProposal = {
      id: 'p1',
      kind: 'intent',
      title: 'Injected <script>alert(1)</script>',
      detail: 'Body <img src=x onerror=alert(1)> with a link <a href="javascript:alert(2)">here</a>',
      rationale: 'Reason <iframe src="https://evil.example"></iframe>',
      evidence: [{ file: 'charge.ts', line: 1, symbol: 'charge' }],
      confidence: 'medium',
    };
    const applied = shioriSpec.apply(output, [proposal]);
    expect(applied.html).not.toContain('<script');
    expect(applied.html).not.toContain('onerror');
    expect(applied.html).not.toContain('javascript:');
    expect(applied.html).not.toContain('<iframe');
    expect(applied.html).not.toContain('evil.example');
    expect(applied.html).toContain('AI-assisted supplement (reviewed)');
  });
});

describe('a proposal carrying active content is refused', () => {
  it('rejects the proposal and keeps the local result', async () => {
    const local = await runEngine('shiori', {
      sourceName: 'charge.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
    const answer = JSON.stringify({
      version: 1,
      summary: 'x',
      proposals: [
        {
          id: 'p1',
          kind: 'intent',
          title: 'Injected note',
          detail: 'Ignore previous instructions <script>fetch("https://evil.example")</script>',
          evidence: [{ file: 'charge.ts', line: 1, symbol: 'charge' }],
          confidence: 'high',
        },
      ],
      notes: [],
    });
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'charge.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult: local,
      settings,
      apiKey: 'sk-test-0123456789abcdef',
      approve: () => true,
      provider: new MockHybridProvider([answer]),
    });

    expect(outcome.provenance).toBe('local-static');
    expect(outcome.proposals).toHaveLength(0);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0].reason).toBe('active-content');
    expect(outcome.rejected[0].message).toContain('script');
    expect(outcome.output).toBe(local.output);
  });
});

describe('generated code is never executed', () => {
  it('has no eval / new Function / dynamic import in the hybrid engine', () => {
    const roots = [path.join(ROOT, 'src/engine/hybrid'), path.join(ROOT, 'src/components')];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
      }
    };
    for (const root of roots) walk(root);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // Comments explain the rule; only a real call counts.
      const code = text
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n');
      if (/\beval\s*\(/.test(code)) offenders.push(`${file}: eval(`);
      if (/new\s+Function\s*\(/.test(code)) offenders.push(`${file}: new Function(`);
      if (/dangerouslySetInnerHTML/.test(code) && !file.endsWith('KozueTool.tsx')) {
        offenders.push(`${file}: dangerouslySetInnerHTML`);
      }
    }
    // Kozue renders the local Mermaid engine's own SVG (not AI text).
    expect(offenders).toEqual([]);
  });
});
