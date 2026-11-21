import { describe, expect, it } from 'vitest';
import { ALL_SECTIONS, ShioriAdapter, buildSpecModel, specToHtml, specToMarkdown } from '../src/tools/shiori/adapter';
import { PY_SAMPLE, TS_SAMPLE } from '../src/tools/samples';

describe('Shiori specification writer', () => {
  const model = buildSpecModel('payment-service.ts', TS_SAMPLE);
  const markdown = specToMarkdown(model);

  it('summarises the source', () => {
    expect(model.language).toBe('TypeScript');
    expect(model.functionCount).toBeGreaterThanOrEqual(4);
    expect(model.contracts.some((c) => c.name === 'PaymentService.charge')).toBe(true);
    expect(model.dependencies.some((d) => d.external && d.module === 'crypto')).toBe(true);
  });

  it('writes a full Markdown specification', () => {
    expect(markdown).toContain('# Specification — payment-service');
    expect(markdown).toContain('## 2. Contract table');
    expect(markdown).toContain('## 3. Behaviour rules');
    expect(markdown).toContain('amount must be positive');
    expect(markdown).toContain('| Function | Line | When | Then |');
    expect(markdown).toContain('## 6. Data types');
  });

  it('honours the section toggles', () => {
    const trimmed = specToMarkdown(model, ['overview', 'contracts']);
    expect(trimmed).toContain('## 1. Overview');
    expect(trimmed).toContain('## 2. Contract table');
    expect(trimmed).not.toContain('## 3. Behaviour rules');
    expect(trimmed).not.toContain('## 5. Dependencies');
  });

  it('renders a standalone HTML document', () => {
    const html = specToHtml(model);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('Contract table');
    expect(html).toContain('<table>');
    expect(html).not.toContain('<script');
  });

  it('runs through the adapter with a cache key and diagnostics', async () => {
    const adapter = new ShioriAdapter();
    const result = await adapter.run({
      toolId: 'shiori',
      sourceName: 'account_service.py',
      source: PY_SAMPLE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
    expect(result.providerMode).toBe('local-static');
    expect(result.cacheKey).toHaveLength(64);
    expect(result.output.markdown).toContain('Python');
    expect(result.output.model.rules.length).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic for the same input', async () => {
    const adapter = new ShioriAdapter();
    const first = await adapter.run({
      toolId: 'shiori',
      sourceName: 'payment-service.ts',
      source: TS_SAMPLE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
    const second = await adapter.run({
      toolId: 'shiori',
      sourceName: 'payment-service.ts',
      source: TS_SAMPLE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
    expect(first.output.markdown).toBe(second.output.markdown);
    expect(first.cacheKey).toBe(second.cacheKey);
  });
});
