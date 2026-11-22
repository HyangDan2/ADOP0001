import { describe, expect, it, beforeEach } from 'vitest';
import {
  DRAFT_VERSION,
  clearDraft,
  draftLabel,
  readDraft,
  readDraftSync,
  resetAllDrafts,
  writeDraft,
  writeDraftNow,
} from '../src/lib/drafts';

const LOCAL_KEY = 'adop0001.draft.shiori';

describe('APP-001 — tool drafts', () => {
  beforeEach(async () => {
    await resetAllDrafts(['shiori', 'yayoi', 'kozue', 'haruhi', 'kotoha', 'takane']);
    localStorage.clear();
  });

  it('round-trips a draft through storage', async () => {
    const data = { source: 'const answer = 42;', fileName: 'answer.ts', sections: ['overview', 'contracts'] };
    const written = await writeDraft('shiori', data);
    expect(['indexeddb', 'localstorage', 'memory']).toContain(written.storage);
    expect(written.error).toBeNull();

    const read = await readDraft<typeof data>('shiori');
    expect(read?.data).toEqual(data);

    // The synchronous path (first render after a remount) sees the same values.
    expect(readDraftSync<typeof data>('shiori')?.data).toEqual(data);
  });

  it('keeps the last edit even when the write is the synchronous unload path', async () => {
    writeDraftNow('haruhi', { source: 'last keystroke', fileName: 'x.ts', framework: 'go' });
    const read = await readDraft<{ source: string }>('haruhi');
    expect(read?.data.source).toBe('last keystroke');
  });

  it('migrates an older record and refuses a newer one', async () => {
    localStorage.setItem(
      LOCAL_KEY,
      JSON.stringify({ version: 0, savedAt: '2026-11-01T00:00:00.000Z', data: { source: 'old build', fileName: 'a.ts' } }),
    );
    const migrated = readDraftSync<{ source: string; fileName: string }>('shiori');
    expect(migrated?.data.source).toBe('old build');
    expect(migrated?.version).toBe(DRAFT_VERSION);

    localStorage.setItem(
      LOCAL_KEY,
      JSON.stringify({ version: DRAFT_VERSION + 5, savedAt: '2026-11-01T00:00:00.000Z', data: { source: 'future' } }),
    );
    expect(readDraftSync('shiori')).toBeNull();
  });

  it('keeps a large source out of localStorage but still restores it', async () => {
    const big = 'x'.repeat(240_000);
    await writeDraft('takane', { source: big, fileName: 'big.md', language: 'python' });
    expect(localStorage.getItem('adop0001.draft.takane')).toBeNull();
    const read = await readDraft<{ source: string }>('takane');
    expect(read?.data.source.length).toBe(240_000);
  });

  it('clears a draft explicitly', async () => {
    await writeDraft('kozue', { source: 'class A {}', fileName: 'a.ts', kind: 'class', direction: 'TD' });
    await clearDraft('kozue');
    expect(await readDraft('kozue')).toBeNull();
    expect(readDraftSync('kozue')).toBeNull();
  });

  it('labels the save state for the status bar', () => {
    expect(draftLabel({ savedAt: null, storage: null, restored: false, error: null })).toBe('下書きなし');
    expect(draftLabel({ savedAt: '2026-11-23T01:02:00.000Z', storage: 'indexeddb', restored: false, error: null })).toContain('下書き保存済み');
    expect(draftLabel({ savedAt: null, storage: null, restored: false, error: '保存できません' })).toBe('保存できません');
  });
});
