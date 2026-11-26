/**
 * INT-003 — the preview is bound to the inputs it was built from.
 *
 * The UI checks the settings fingerprint and the input fingerprint immediately
 * before it sends. These cases exercise the identity functions that check uses, on
 * the same stores the panel and the prompt pane write.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { inputsFingerprintFor, planHybridRequest } from '../src/engine/hybrid/requestPlan';
import { DEFAULT_CONNECTION_SETTINGS, settingsFingerprint, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { savePrompt } from '../src/lib/promptStore';
import { clearExamples, saveExample } from '../src/lib/fewShotStore';

const settings: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
};

const SOURCE = 'export function pay() {\n  return 1;\n}\n';

beforeEach(async () => {
  await clearExamples();
  savePrompt('shiori', 'Use snake_case names.');
});

describe('INT-003 — request lifecycle integration', () => {
  it('changes the settings fingerprint on every setting the body or budget uses', () => {
    const base = settingsFingerprint(settings);
    expect(settingsFingerprint({ ...settings, temperature: 0.9 })).not.toBe(base);
    expect(settingsFingerprint({ ...settings, maxOutputTokens: 1024 })).not.toBe(base);
    expect(settingsFingerprint({ ...settings, streaming: false })).not.toBe(base);
    expect(settingsFingerprint({ ...settings, providerId: 'local-gateway' })).not.toBe(base);
    expect(settingsFingerprint({ ...settings })).toBe(base);
  });

  it('detects a prompt or few-shot edit made after the preview', async () => {
    const plan = await planHybridRequest({
      toolId: 'shiori',
      source: SOURCE,
      sourceName: 'pay.ts',
      settings,
      localAnalysis: 'contracts: 1',
    });
    const unchanged = await inputsFingerprintFor({
      toolId: 'shiori',
      source: SOURCE,
      sourceName: 'pay.ts',
      settings,
    });
    expect(unchanged).toBe(plan.inputsFingerprint);

    savePrompt('shiori', 'Use camelCase names.');
    const promptChanged = await inputsFingerprintFor({
      toolId: 'shiori',
      source: SOURCE,
      sourceName: 'pay.ts',
      settings,
    });
    expect(promptChanged).not.toBe(plan.inputsFingerprint);

    savePrompt('shiori', 'Use snake_case names.');
    await saveExample({
      toolId: 'shiori',
      title: 'example',
      outputFileName: 'example.md',
      outputText: '# Example\n',
      targetLanguage: 'markdown',
      enabled: true,
    });
    const exampleChanged = await inputsFingerprintFor({
      toolId: 'shiori',
      source: SOURCE,
      sourceName: 'pay.ts',
      settings,
    });
    expect(exampleChanged).not.toBe(plan.inputsFingerprint);
  });

  it('invalidates the preview when the settings move, even with the same source', async () => {
    const plan = await planHybridRequest({
      toolId: 'shiori',
      source: SOURCE,
      sourceName: 'pay.ts',
      settings,
      localAnalysis: 'contracts: 1',
    });
    const moved = await inputsFingerprintFor({
      toolId: 'shiori',
      source: SOURCE,
      sourceName: 'pay.ts',
      settings: { ...settings, temperature: 1.1 },
    });
    expect(moved).not.toBe(plan.inputsFingerprint);
    expect(settingsFingerprint({ ...settings, temperature: 1.1 })).not.toBe(plan.settingsFingerprint);
  });

  it('keeps a Kotoha send scope to the ticked sections and keeps the line numbers', async () => {
    const markdown = ['# Title', 'intro', '## A', 'alpha', '## B', 'bravo', '## C', 'charlie'].join('\n');
    const plan = await planHybridRequest({
      toolId: 'kotoha',
      source: markdown,
      sourceName: 'doc.md',
      settings,
      sectionSelection: [0, 2],
    });
    expect(plan.sendSections).toBeTruthy();
    expect(plan.sendSections!.selected).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ]);
    expect(plan.sendSections!.excluded).toEqual([
      { start: 3, end: 4 },
      { start: 7, end: 8 },
    ]);
    const payload = plan.preview.messages.map((message) => message.content).join('\n');
    expect(payload).toContain('bravo');
    expect(payload).not.toContain('alpha');
    expect(payload).not.toContain('charlie');
  });
});
