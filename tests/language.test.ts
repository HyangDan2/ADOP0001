import { describe, expect, it } from 'vitest';
import { ShioriAdapter } from '../src/tools/shiori/adapter';
import { YayoiAdapter } from '../src/tools/yayoi/adapter';
import { KozueAdapter } from '../src/tools/kozue/adapter';
import { HaruhiAdapter } from '../src/tools/haruhi/adapter';
import { TakaneAdapter } from '../src/tools/takane/adapter';
import { TS_SAMPLE } from '../src/tools/samples';
import { PAYMENT_SPEC } from '../src/tools/takane/samples';

const CJK = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/;

const request = (toolId: 'shiori' | 'yayoi' | 'kozue' | 'haruhi' | 'takane') => ({
  toolId,
  sourceName: 'payment-service.ts',
  source: toolId === 'takane' ? PAYMENT_SPEC : TS_SAMPLE,
  options: toolId === 'kozue' ? { kind: 'auto' as const, direction: 'TD' as const } : {},
  mode: 'local-static' as const,
});

/**
 * The UI is Japanese, but every artifact a tool produces stays English:
 * specifications, pseudocode, diagrams, tests and generated code.
 */
describe('tool outputs stay English', () => {
  it('枝織 writes an English specification', async () => {
    const result = await new ShioriAdapter().run(request('shiori') as never);
    const output = result.output as { markdown: string; html: string };
    expect(output.markdown).not.toMatch(CJK);
    expect(output.html).not.toMatch(CJK);
  });

  it('弥生 writes English pseudocode in every style', async () => {
    const adapter = new YayoiAdapter();
    for (const style of ['standard', 'narrative', 'compact'] as const) {
      const result = await adapter.run({
        ...request('yayoi'),
        options: { style, depth: 'detailed' },
      } as never);
      const output = result.output as { markdown: string; plain: string };
      expect(output.markdown).not.toMatch(CJK);
      expect(output.plain).not.toMatch(CJK);
    }
  });

  it('梢絵 writes English Mermaid dialects', async () => {
    const result = await new KozueAdapter().run(request('kozue') as never);
    const output = result.output as { mermaid: Record<string, string> };
    for (const code of Object.values(output.mermaid)) {
      if (code) expect(code).not.toMatch(CJK);
    }
  });

  it('春日 writes English test files for every framework', async () => {
    const adapter = new HaruhiAdapter();
    for (const framework of ['vitest', 'jest', 'pytest', 'junit5', 'go'] as const) {
      const result = await adapter.run({ ...request('haruhi'), options: { framework } } as never);
      expect((result.output as { code: string }).code).not.toMatch(CJK);
    }
  });

  it('貴音 writes English scaffolds for all four languages', async () => {
    const adapter = new TakaneAdapter();
    for (const language of ['python', 'c', 'cpp', 'mcu'] as const) {
      const result = await adapter.run({ ...request('takane'), options: { language } } as never);
      expect((result.output as { code: string }).code).not.toMatch(CJK);
    }
  });
});
