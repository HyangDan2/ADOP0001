import { describe, expect, it } from 'vitest';
import { buildPseudocode } from '../src/tools/yayoi/adapter';
import { TS_SAMPLE, PY_SAMPLE } from '../src/tools/samples';

describe('Yayoi pseudocode studio', () => {
  it('produces structured pseudocode with control flow', () => {
    const output = buildPseudocode('payment-service.ts', TS_SAMPLE, { style: 'standard', depth: 'detailed' });
    const text = output.blocks.flatMap((b) => b.lines.map((l) => l.text)).join('\n');
    expect(output.blocks.length).toBeGreaterThanOrEqual(4);
    expect(text).toContain('FUNCTION PaymentService.charge');
    expect(text).toMatch(/IF .* THEN/);
    expect(text).toContain('THROW');
    expect(text).toContain('FOR');
    expect(text).toContain('TRY');
    expect(text).toContain('CATCH');
    expect(text).toContain('RETURN');
  });

  it('switches between the three styles', () => {
    const narrative = buildPseudocode('a.py', PY_SAMPLE, { style: 'narrative', depth: 'detailed' });
    const narrativeText = narrative.blocks.flatMap((b) => b.lines.map((l) => l.text)).join('\n');
    expect(narrativeText).toMatch(/When .*,/);
    expect(narrativeText).toContain('The function raises');

    const compact = buildPseudocode('a.py', PY_SAMPLE, { style: 'compact', depth: 'detailed' });
    const compactText = compact.blocks.flatMap((b) => b.lines.map((l) => l.text)).join('\n');
    expect(compactText).toMatch(/^1\. /m);
    expect(compactText).toMatch(/^2\. /m);
  });

  it('honours the depth toggle', () => {
    const detailed = buildPseudocode('payment-service.ts', TS_SAMPLE, { style: 'standard', depth: 'detailed' });
    const summary = buildPseudocode('payment-service.ts', TS_SAMPLE, { style: 'standard', depth: 'summary' });
    const detailedCount = detailed.blocks.reduce((sum, b) => sum + b.lines.length, 0);
    const summaryCount = summary.blocks.reduce((sum, b) => sum + b.lines.length, 0);
    expect(summaryCount).toBeLessThan(detailedCount);
    expect(summaryCount).toBeGreaterThan(0);
  });

  it('keeps a bidirectional line map', () => {
    const output = buildPseudocode('payment-service.ts', TS_SAMPLE, { style: 'standard', depth: 'detailed' });
    const sourceLines = TS_SAMPLE.split('\n').length;
    for (const block of output.blocks) {
      for (const line of block.lines) {
        if (line.sourceLine === null) continue;
        expect(line.sourceLine).toBeGreaterThanOrEqual(1);
        expect(line.sourceLine).toBeLessThanOrEqual(sourceLines);
        expect(output.fromSource[line.sourceLine]).toContain(line.id);
        expect(output.toSource[line.id]).toBe(line.sourceLine);
      }
    }
    const firstGuardLine = output.blocks
      .flatMap((b) => b.lines)
      .find((l) => l.text.startsWith('IF'));
    expect(firstGuardLine?.sourceLine).toBeGreaterThan(0);
  });

  it('exports Markdown and plain text', () => {
    const output = buildPseudocode('a.py', PY_SAMPLE, { style: 'standard', depth: 'detailed' });
    expect(output.markdown).toContain('# Pseudocode — a');
    expect(output.markdown).toContain('```text');
    expect(output.plain.length).toBeGreaterThan(50);
    expect(output.stats.functions).toBeGreaterThanOrEqual(3);
  });
});
