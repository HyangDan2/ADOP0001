/**
 * WO-10 — per-tool schemas, evidence and merge.
 *
 * One rule runs through every case: the local result is the fact, the model's
 * answer is a proposal, and a proposal that cannot be traced back to a symbol,
 * a line or a quote in the local result is rejected before the user sees it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine/core/runner';
import { runHybridPass } from '../src/engine/hybrid/orchestrator';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { MockHybridProvider } from '../src/engine/hybrid/mock';
import { mergeProposals, parseEnvelope } from '../src/engine/hybrid/mergePolicy';
import { toolHybridSpec, HYBRID_TOOL_IDS } from '../src/engine/hybrid/tools';
import { checkMermaidSnippet, mermaidIds, kozueSpec } from '../src/engine/hybrid/tools/kozue';
import { kotohaSpec } from '../src/engine/hybrid/tools/kotoha';
import { takaneSpec } from '../src/engine/hybrid/tools/takane';
import { shioriSpec } from '../src/engine/hybrid/tools/shiori';
import { haruhiSpec } from '../src/engine/hybrid/tools/haruhi';
import { yayoiSpec } from '../src/engine/hybrid/tools/yayoi';
import { ALL_SECTIONS, type ShioriOutput } from '../src/tools/shiori/adapter';
import type { HaruhiOutput } from '../src/tools/haruhi/adapter';
import type { YayoiOutput } from '../src/tools/yayoi/adapter';
import type { KozueOutput } from '../src/tools/kozue/adapter';
import type { KotohaOutput } from '../src/tools/kotoha/adapter';
import type { TakaneOutput } from '../src/tools/takane/adapter';
import { buildSampleDocx } from '../src/tools/kotoha/sample';
import { decomposeDocx } from '../src/tools/kotoha/read';
import { PAYMENT_SPEC } from '../src/tools/takane/samples';

const SOURCE = [
  'export function pay(amount: number): boolean {',
  '  if (amount <= 0) throw new Error("amount must be positive");',
  '  return true;',
  '}',
  '',
  'export function refund(id: string): boolean {',
  '  if (!id) return false;',
  '  return true;',
  '}',
  '',
].join('\n');

const settings: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  streaming: true,
};

async function shiori(): Promise<ShioriOutput> {
  const result = await runEngine('shiori', {
    sourceName: 'payment.ts',
    source: SOURCE,
    options: { sections: ALL_SECTIONS, includePrivate: true },
    mode: 'local-static',
  });
  return result.output;
}

async function haruhi(): Promise<HaruhiOutput> {
  const result = await runEngine('haruhi', {
    sourceName: 'payment.ts',
    source: SOURCE,
    options: { framework: 'vitest' },
    mode: 'local-static',
  });
  return result.output;
}

async function yayoi(): Promise<YayoiOutput> {
  const result = await runEngine('yayoi', {
    sourceName: 'payment.ts',
    source: SOURCE,
    options: { style: 'standard', depth: 'detailed' },
    mode: 'local-static',
  });
  return result.output;
}

async function kozue(): Promise<KozueOutput> {
  const result = await runEngine('kozue', {
    sourceName: 'payment.ts',
    source: SOURCE,
    options: { kind: 'auto', direction: 'TD' },
    mode: 'local-static',
  });
  return result.output;
}

async function kotoha(): Promise<KotohaOutput> {
  const bytes = await buildSampleDocx();
  const document = await decomposeDocx(bytes, 'kotoha-sample.docx');
  return {
    action: 'decompose',
    fileName: 'kotoha-sample.docx',
    markdown: document.markdown,
    bundle: document.bundle,
    docx: bytes,
    paragraphs: document.bundle.stats.paragraphs,
    tables: document.bundle.stats.tables,
    warnings: document.bundle.warnings ?? [],
  };
}

async function takane(): Promise<TakaneOutput> {
  const result = await runEngine('takane', {
    sourceName: 'payment-service.spec.md',
    source: PAYMENT_SPEC,
    options: { language: 'python' },
    mode: 'local-static',
  });
  return result.output;
}

describe('registry', () => {
  it('has a spec for every tool and no tool-local free-text path', () => {
    expect(HYBRID_TOOL_IDS).toHaveLength(6);
    for (const id of HYBRID_TOOL_IDS) {
      const spec = toolHybridSpec(id);
      expect(spec.toolId).toBe(id);
      expect(spec.outputSchema).toContain('"version": 1');
      expect(spec.outputSchema).toContain('evidence');
      expect(spec.proposalKinds.length).toBeGreaterThan(0);
    }
  });

  it('never mentions eval or a dynamic import in the tool specs', () => {
    for (const file of ['takane', 'haruhi', 'shiori', 'kotoha', 'kozue', 'yayoi']) {
      const body = readFileSync(`src/engine/hybrid/tools/${file}.ts`, 'utf8');
      expect(body).not.toMatch(/\beval\s*\(/);
      expect(body).not.toMatch(/new Function\s*\(/);
    }
  });
});

describe('Shiori (pilot)', () => {
  it('describes contracts with their lines and nothing invented', async () => {
    const output = await shiori();
    const description = shioriSpec.describeLocal(output);
    expect(description).toContain('pay (L1)');
    expect(description).toContain('refund (L6)');
    expect(description).not.toContain('  return true;'); // the fact sheet, not the file body
  });

  it('accepts a cited proposal and appends it without touching the model', async () => {
    const output = await shiori();
    const facts = shioriSpec.facts(output, 'payment.ts', SOURCE);
    const merged = mergeProposals(
      {
        version: 1,
        summary: 'ok',
        proposals: [
          {
            id: 'p1',
            kind: 'error-handling',
            title: 'Document the throw',
            detail: 'pay rejects a non-positive amount before charging.',
            evidence: [{ line: 2, symbol: 'pay', quote: 'amount <= 0' }],
          },
        ],
      },
      facts,
      shioriSpec.proposalKinds,
    );
    expect(merged.rejected).toHaveLength(0);
    const applied = shioriSpec.apply(output, merged.proposals);
    expect(applied.markdown).toContain('AI-assisted supplement');
    expect(applied.markdown).toContain('Document the throw');
    expect(applied.markdown.startsWith(output.markdown)).toBe(true);
    expect(applied.html).toContain('ai-supplement');
    expect(applied.model).toBe(output.model);
  });
});

describe('Haruhi (pilot)', () => {
  it('cites functions from the derived cases', async () => {
    const output = await haruhi();
    const facts = haruhiSpec.facts(output, 'payment.ts', SOURCE);
    expect(facts.symbols.get('pay')?.length).toBeGreaterThan(0);
    const merged = mergeProposals(
      {
        version: 1,
        summary: '',
        proposals: [
          {
            id: 'h1',
            kind: 'boundary',
            title: 'Amount of zero',
            detail: 'Add a case for amount = 0, which the guard rejects.',
            evidence: [{ symbol: 'pay', line: output.cases[0].fn.startLine }],
          },
        ],
      },
      facts,
      haruhiSpec.proposalKinds,
    );
    expect(merged.proposals).toHaveLength(1);
    const applied = haruhiSpec.apply(output, merged.proposals);
    expect(applied.code.startsWith(output.code)).toBe(true);
    expect(applied.code).toContain('AI-suggested tests');
    expect(applied.code).toContain('// AI-suggested tests'.slice(3)); // inside a comment block
    expect(applied.cases).toBe(output.cases);
  });

  it('rejects a case that cites a function the parser did not find', async () => {
    const output = await haruhi();
    const facts = haruhiSpec.facts(output, 'payment.ts', SOURCE);
    const merged = mergeProposals(
      {
        version: 1,
        summary: '',
        proposals: [
          { id: 'h2', kind: 'negative', title: 'Refund', detail: 'x', evidence: [{ symbol: 'settle' }] },
        ],
      },
      facts,
      haruhiSpec.proposalKinds,
    );
    expect(merged.proposals).toHaveLength(0);
    expect(merged.rejected[0].reason).toBe('unknown-symbol');
  });
});

describe('Yayoi', () => {
  it('cites pseudocode blocks and only appends to the readable form', async () => {
    const output = await yayoi();
    const facts = yayoiSpec.facts(output, 'payment.ts', SOURCE);
    expect(facts.symbols.get('pay')?.length).toBe(1);
    const merged = mergeProposals(
      {
        version: 1,
        summary: '',
        proposals: [
          {
            id: 'y1',
            kind: 'flow',
            title: 'Explain the guard',
            detail: 'The first branch rejects a non-positive amount before any charge.',
            evidence: [{ symbol: 'pay', line: 1 }],
          },
        ],
      },
      facts,
      yayoiSpec.proposalKinds,
    );
    const applied = yayoiSpec.apply(output, merged.proposals);
    expect(applied.markdown).toContain('AI-assisted explanation');
    expect(applied.plain).toBe(output.plain);
    expect(applied.toSource).toBe(output.toSource);
  });
});

describe('Kozue', () => {
  it('knows the elements of the generated diagram', async () => {
    const output = await kozue();
    const ids = mermaidIds(output.mermaid[output.activeKind]);
    expect(ids.size).toBeGreaterThan(0);
    const [known] = [...ids];
    const facts = kozueSpec.facts(output, 'payment.ts', SOURCE);
    expect(facts.symbols.has(known)).toBe(true);
    expect(facts.requireSymbol).toBe(true);
  });

  it('checks a proposed Mermaid fragment against the diagram', async () => {
    const output = await kozue();
    const ids = [...mermaidIds(output.mermaid[output.activeKind])];
    const [a, b] = ids;
    const good = `sequenceDiagram\n  ${a}->>${b}: call`;
    expect(checkMermaidSnippet(good, new Set(ids)).ok).toBe(true);
    expect(checkMermaidSnippet('sequenceDiagram\n  A->>Ghost: call', new Set(ids))).toMatchObject({ ok: false });
    expect(checkMermaidSnippet('pie title x', new Set(ids))).toMatchObject({ ok: false });
    expect(checkMermaidSnippet('sequenceDiagram\n  A->>B: call\n  loop [', new Set(ids))).toMatchObject({ ok: false });
    expect(
      checkMermaidSnippet(`sequenceDiagram\n  participant New\n  New->>${a}: x`, new Set(ids), { allowNewDeclarations: false }),
    ).toMatchObject({ ok: false });
  });

  it('adds an accepted fragment as comments, not as diagram syntax', async () => {
    const output = await kozue();
    const ids = [...mermaidIds(output.mermaid[output.activeKind])];
    const merged = mergeProposals(
      {
        version: 1,
        summary: '',
        proposals: [
          {
            id: 'k1',
            kind: 'sequence',
            title: 'Show the guard call',
            detail: 'The diagram does not show the early return.',
            code: `sequenceDiagram\n  ${ids[0]}->>${ids[1]}: guard`,
            evidence: [{ symbol: ids[0] }],
          },
        ],
      },
      kozueSpec.facts(output, 'payment.ts', SOURCE),
      kozueSpec.proposalKinds,
    );
    expect(merged.proposals).toHaveLength(1);
    expect(kozueSpec.checkProposal?.(merged.proposals[0], output)).toBeNull();
    const applied = kozueSpec.apply(output, merged.proposals);
    expect(applied.mermaid[output.activeKind].startsWith(output.mermaid[output.activeKind])).toBe(true);
    expect(applied.mermaid[output.activeKind]).toContain('%% AI-assisted supplement');
    for (const kind of Object.keys(output.mermaid) as Array<keyof typeof output.mermaid>) {
      if (kind !== output.activeKind) expect(applied.mermaid[kind]).toBe(output.mermaid[kind]);
    }
  });

  it('rejects a Mermaid proposal that invents a participant', async () => {
    const output = await kozue();
    const ids = [...mermaidIds(output.mermaid[output.activeKind])];
    const merged = mergeProposals(
      {
        version: 1,
        summary: '',
        proposals: [
          {
            id: 'k2',
            kind: 'sequence',
            title: 'New participant',
            detail: 'x',
            code: `sequenceDiagram\n  participant Bank\n  Bank->>${ids[0]}: charge`,
            evidence: [{ symbol: ids[0] }],
          },
        ],
      },
      kozueSpec.facts(output, 'payment.ts', SOURCE),
      kozueSpec.proposalKinds,
    );
    expect(kozueSpec.checkProposal?.(merged.proposals[0], output)).toContain('存在しない要素');
  });
});

describe('Kotoha', () => {
  it('describes only the selected Markdown, never the DOCX bytes', async () => {
    const output = await kotoha();
    const description = kotohaSpec.describeLocal(output);
    expect(description).toContain('headings:');
    expect(description.length).toBeLessThan(8000);
    // The ZIP signature of a .docx must not appear in anything the model sees.
    expect(description).not.toContain('UEsDB');
    expect(description).not.toMatch(/data:image\//);
  });

  it('cites headings and refuses a proposal that carries an image', async () => {
    const output = await kotoha();
    const facts = kotohaSpec.facts(output, output.fileName, output.markdown);
    const heading = [...facts.symbols.keys()][0];
    const merged = mergeProposals(
      {
        version: 1,
        summary: '',
        proposals: [
          { id: 't1', kind: 'structure', title: 'Add a summary', detail: 'A short summary before the first heading.', evidence: [{ symbol: heading }] },
        ],
      },
      facts,
      kotohaSpec.proposalKinds,
    );
    expect(merged.proposals).toHaveLength(1);
    expect(kotohaSpec.checkProposal?.(merged.proposals[0], output)).toBeNull();
    const withImage = {
      ...merged.proposals[0],
      detail: '![x](data:image/png;base64,iVBORw0KGgo=)',
    };
    expect(kotohaSpec.checkProposal?.(withImage, output)).toContain('拒否');
    const applied = kotohaSpec.apply(output, merged.proposals);
    expect(applied.markdown).toContain('AI-assisted document notes');
    expect(applied.bundle).toBe(output.bundle);
  });

  it('sends the selected Markdown and nothing else', async () => {
    const output = await kotoha();
    const provider = new MockHybridProvider([JSON.stringify({ version: 1, summary: '', proposals: [] })]);
    await runHybridPass({
      toolId: 'kotoha',
      sourceName: output.fileName,
      source: output.markdown,
      options: { action: 'decompose' },
      localResult: {
        output,
        providerMode: 'local-static',
        diagnostics: [],
        elapsedMs: 1,
        cacheKey: 'k',
        context: {
          requestId: 'r',
          toolId: 'kotoha',
          sourceName: output.fileName,
          sourceHash: 'h',
          options: { action: 'decompose' },
          providerMode: 'local-static',
          diagnostics: [],
          elapsedMs: 1,
          cacheKey: 'k',
          engineVersion: '5b.2',
          cacheHit: false,
        },
      },
      settings,
      apiKey: 'sk-test',
      approve: () => true,
      provider,
    });
    const body = JSON.stringify(provider.requests[0].messages);
    expect(body).toContain('headings');
    expect(body).not.toContain('UEsDB');
    expect(body).not.toMatch(/data:image\//);
  });
});

describe('Takane', () => {
  it('cites parsed contracts and keeps generated code unexecuted', async () => {
    const output = await takane();
    const description = takaneSpec.describeLocal(output);
    expect(description).toContain('charge');
    const facts = takaneSpec.facts(output, 'payment-service.spec.md', PAYMENT_SPEC);
    expect(facts.symbols.has('charge')).toBe(true);
    expect(facts.symbols.has('PaymentService.charge')).toBe(true);

    const merged = mergeProposals(
      {
        version: 1,
        summary: '',
        proposals: [
          {
            id: 'g1',
            kind: 'implementation',
            title: 'Implement charge',
            detail: 'Validate the invoice id before charging.',
            code: 'def charge(request):\n    return None\n',
            evidence: [{ symbol: 'charge' }],
          },
        ],
      },
      facts,
      takaneSpec.proposalKinds,
    );
    expect(merged.proposals).toHaveLength(1);
    const applied = takaneSpec.apply(output, merged.proposals);
    expect(applied.code).toContain('AI-assisted implementation proposals');
    expect(applied.code).toContain('# def charge(request):');
    expect(applied.files[applied.files.length - 1].code).toContain('AI-assisted implementation proposals');
  });

  it('rejects an implementation for a contract that is not in the specification', async () => {
    const output = await takane();
    const facts = takaneSpec.facts(output, 'payment-service.spec.md', PAYMENT_SPEC);
    const merged = mergeProposals(
      {
        version: 1,
        summary: '',
        proposals: [
          { id: 'g2', kind: 'implementation', title: 'Settle', detail: 'x', code: 'x', evidence: [{ symbol: 'settle' }] },
        ],
      },
      facts,
      takaneSpec.proposalKinds,
    );
    expect(merged.proposals).toHaveLength(0);
    expect(merged.rejected[0].reason).toBe('unknown-symbol');
  });
});

describe('envelope schema', () => {
  it('rejects a free-text answer and an unknown top-level field', () => {
    expect(() => parseEnvelope('plain answer', ['intent'])).toThrow(/JSON オブジェクト/);
    expect(() => parseEnvelope({ version: 1, summary: '', proposals: [], answer: 'text' }, ['intent'])).toThrow(/未知の項目/);
    expect(() => parseEnvelope({ version: 2, summary: '', proposals: [] }, ['intent'])).toThrow(/version/);
  });

  it('requires evidence for every proposal', () => {
    expect(() =>
      parseEnvelope(
        { version: 1, summary: '', proposals: [{ id: 'a', kind: 'intent', title: 't', detail: 'd', evidence: [] }] },
        ['intent'],
      ),
    ).toThrow(/evidence/);
  });
});
