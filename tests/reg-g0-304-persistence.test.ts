// @vitest-environment happy-dom
/**
 * BUG-304 — draft deletion must report each persistence store independently and
 * reset/autosave ordering must never bring a discarded draft back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolId } from '../src/adapters/types';
import {
  DRAFT_VERSION,
  clearDraft,
  draftStoreEpoch,
  readDraft,
  readDraftSync,
  resetAllDrafts,
  writeDraft,
  writeDraftNow,
} from '../src/lib/drafts';

const ALL_TOOLS: ToolId[] = ['shiori', 'yayoi', 'kozue', 'haruhi', 'kotoha', 'takane'];
const LOCAL_PREFIX = 'adop0001.draft.';
const localKey = (toolId: ToolId) => `${LOCAL_PREFIX}${toolId}`;
const draftData = (label: string) => ({ source: `${label} source`, fileName: `${label}.ts` });

/* ------------------------------------------------------------------ */
/* Controllable Map-backed IndexedDB fake                              */
/* ------------------------------------------------------------------ */

interface FakeControl {
  abort: boolean;
  refuseOpen: boolean;
  failDeleteTools: Set<string>;
}

interface FakeIndexedDb {
  store: Map<string, unknown>;
  control: FakeControl;
  openCalls: Array<{ name: string; version: number }>;
  transactionStores: string[];
  whenIdle: () => Promise<void>;
}

function installFakeIndexedDb(): FakeIndexedDb {
  const store = new Map<string, unknown>();
  const control: FakeControl = {
    abort: false,
    refuseOpen: false,
    failDeleteTools: new Set<string>(),
  };
  const openCalls: Array<{ name: string; version: number }> = [];
  const transactionStores: string[] = [];
  const idleWaiters = new Set<() => void>();
  let pending = 0;
  let started = 0;

  const notifyIdle = () => {
    if (pending !== 0) return;
    const waiters = [...idleWaiters];
    idleWaiters.clear();
    for (const resolve of waiters) resolve();
  };

  const whenIdle = async () => {
    for (;;) {
      const before = started;
      // A macrotask yield lets queued promise continuations start their next fake operation.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      if (pending === 0 && started === before) return;
      if (pending > 0) {
        await new Promise<void>((resolve) => idleWaiters.add(resolve));
      }
    }
  };

  const makeTransaction = () => {
    const ops: Array<() => void> = [];
    let deleteRefused = false;
    const handle = {
      put(value: unknown, key: string) {
        ops.push(() => store.set(key, value));
        return {};
      },
      delete(key: string) {
        ops.push(() => {
          if (control.failDeleteTools.has(key)) {
            deleteRefused = true;
            return;
          }
          store.delete(key);
        });
        return {};
      },
      get(key: string) {
        const request = { result: undefined as unknown, onsuccess: null as (() => void) | null };
        ops.push(() => {
          request.result = store.get(key);
          request.onsuccess?.();
        });
        return request;
      },
    };
    const transaction = {
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      objectStore: () => handle,
    };

    started += 1;
    pending += 1;
    setTimeout(() => {
      try {
        if (control.abort) {
          transaction.onabort?.();
          return;
        }
        for (const op of ops) {
          op();
          if (deleteRefused) break;
        }
        if (deleteRefused) transaction.onabort?.();
        else transaction.oncomplete?.();
      } finally {
        pending -= 1;
        queueMicrotask(notifyIdle);
      }
    }, 0);
    return transaction;
  };

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    transaction: (storeName: string) => {
      transactionStores.push(storeName);
      return makeTransaction();
    },
    close: () => undefined,
  };
  const factory = {
    open: (name: string, version: number) => {
      openCalls.push({ name, version });
      const request = {
        result: db,
        onsuccess: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      };

      started += 1;
      pending += 1;
      setTimeout(() => {
        try {
          if (control.refuseOpen) request.onerror?.();
          else request.onsuccess?.();
        } finally {
          pending -= 1;
          queueMicrotask(notifyIdle);
        }
      }, 0);
      return request;
    },
  };
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory as unknown as IDBFactory;
  return { store, control, openCalls, transactionStores, whenIdle };
}

/* ------------------------------------------------------------------ */
/* Isolation                                                           */
/* ------------------------------------------------------------------ */

const originalIndexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let fake: FakeIndexedDb;

function restoreGlobal(name: 'indexedDB' | 'localStorage', descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as unknown as Record<string, unknown>)[name];
}

beforeEach(() => {
  localStorage.clear();
  fake = installFakeIndexedDb();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live network is disabled in BUG-304 tests'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  fake.control.abort = false;
  fake.control.refuseOpen = false;
  fake.control.failDeleteTools.clear();
  try {
    await resetAllDrafts(ALL_TOOLS);
  } finally {
    try {
      localStorage.clear();
      await fake.whenIdle();
    } finally {
      restoreGlobal('indexedDB', originalIndexedDbDescriptor);
      restoreGlobal('localStorage', originalLocalStorageDescriptor);
    }
  }
});

/* ------------------------------------------------------------------ */
/* BUG-304 regression cases                                            */
/* ------------------------------------------------------------------ */

describe('BUG-304 draft persistence', () => {
  it('REG-G0-304A — localStorage removeItem failure reports a partial clear and preserves the local copy', async () => {
    const toolId: ToolId = 'shiori';
    const data = draftData('local-delete-denied');
    await writeDraft(toolId, data);
    const raw = localStorage.getItem(localKey(toolId));
    expect(raw).not.toBeNull();
    expect(fake.store.get(toolId)).toMatchObject({ version: DRAFT_VERSION, toolId, data });

    const removeItem = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('localStorage removeItem denied');
    });
    const result = await clearDraft(toolId);

    expect(result).toEqual({
      ok: false,
      idb: 'ok',
      localStorage: 'failed',
      memory: 'ok',
      partial: true,
      error: expect.stringContaining('localStorage'),
    });
    expect(fake.store.has(toolId)).toBe(false);
    expect(localStorage.getItem(localKey(toolId))).toBe(raw);
    expect(readDraftSync(toolId)?.data).toEqual(data);

    removeItem.mockRestore();
    await expect(readDraft(toolId)).resolves.toEqual({ data, savedAt: expect.any(String), storage: 'localstorage' });
  });

  it('REG-G0-304B — reports both partial-store directions and resetAllDrafts per-tool outcomes', async () => {
    const shioriData = draftData('shiori-local-failure');
    const yayoiData = draftData('yayoi-idb-failure');
    const kozueData = draftData('kozue-success');
    await writeDraft('shiori', shioriData);
    await writeDraft('yayoi', yayoiData);
    await writeDraft('kozue', kozueData);
    const shioriRaw = localStorage.getItem(localKey('shiori'));

    const originalRemoveItem = localStorage.removeItem.bind(localStorage);
    const removeItem = vi.spyOn(localStorage, 'removeItem').mockImplementation((key: string) => {
      if (key === localKey('shiori')) throw new Error('localStorage removeItem denied for shiori');
      originalRemoveItem(key);
    });
    fake.control.failDeleteTools.add('yayoi');

    const localFailure = await clearDraft('shiori');
    expect(localFailure).toEqual({
      ok: false,
      idb: 'ok',
      localStorage: 'failed',
      memory: 'ok',
      partial: true,
      error: expect.stringContaining('localStorage'),
    });
    expect(fake.store.has('shiori')).toBe(false);
    expect(localStorage.getItem(localKey('shiori'))).toBe(shioriRaw);

    const idbFailure = await clearDraft('yayoi');
    expect(idbFailure).toEqual({
      ok: false,
      idb: 'failed',
      localStorage: 'ok',
      memory: 'ok',
      partial: true,
      error: expect.stringContaining('IndexedDB'),
    });
    expect(fake.store.get('yayoi')).toMatchObject({ toolId: 'yayoi', data: yayoiData });
    expect(localStorage.getItem(localKey('yayoi'))).toBeNull();

    // Re-seed the two partially cleared tools so resetAllDrafts must report each outcome again.
    await writeDraft('shiori', shioriData);
    await writeDraft('yayoi', yayoiData);
    const reset = await resetAllDrafts(['shiori', 'yayoi', 'kozue']);

    expect(reset).toMatchObject({
      ok: false,
      failed: ['shiori', 'yayoi'],
      idb: 'failed',
      localStorage: 'failed',
      memory: 'ok',
      partial: true,
      error: expect.stringContaining('一部'),
    });
    expect(reset.results).toEqual([
      {
        toolId: 'shiori',
        result: {
          ok: false,
          idb: 'ok',
          localStorage: 'failed',
          memory: 'ok',
          partial: true,
          error: expect.stringContaining('localStorage'),
        },
      },
      {
        toolId: 'yayoi',
        result: {
          ok: false,
          idb: 'failed',
          localStorage: 'ok',
          memory: 'ok',
          partial: true,
          error: expect.stringContaining('IndexedDB'),
        },
      },
      {
        toolId: 'kozue',
        result: { ok: true, idb: 'ok', localStorage: 'ok', memory: 'ok', partial: false, error: null },
      },
    ]);
    expect(fake.store.has('shiori')).toBe(false);
    expect(fake.store.has('yayoi')).toBe(true);
    expect(fake.store.has('kozue')).toBe(false);
    expect(localStorage.getItem(localKey('shiori'))).not.toBeNull();
    expect(localStorage.getItem(localKey('yayoi'))).toBeNull();
    expect(localStorage.getItem(localKey('kozue'))).toBeNull();

    // Remove only the durable leftovers to prove reset also cleared every in-memory copy.
    removeItem.mockRestore();
    fake.control.failDeleteTools.clear();
    fake.store.clear();
    localStorage.clear();
    for (const toolId of ['shiori', 'yayoi', 'kozue'] as const) {
      await expect(readDraft(toolId)).resolves.toBeNull();
    }
  });

  it('REG-G0-304C — queued and stale autosaves cannot resurrect a reset draft', async () => {
    const toolId: ToolId = 'haruhi';
    await writeDraft(toolId, draftData('before-reset'));
    const staleEpoch = draftStoreEpoch();

    const queued = writeDraft(toolId, draftData('queued-autosave'), { epoch: staleEpoch });
    const resetting = resetAllDrafts([toolId]);
    const [written, reset] = await Promise.all([queued, resetting]);
    expect(written.superseded).toBe(true);
    expect(reset).toMatchObject({ ok: true, failed: [], partial: false, memory: 'ok' });
    await expect(readDraft(toolId)).resolves.toBeNull();

    writeDraftNow(toolId, draftData('stale-epoch-unload'), { epoch: staleEpoch });
    await fake.whenIdle();
    expect(localStorage.getItem(localKey(toolId))).toBeNull();
    expect(fake.store.has(toolId)).toBe(false);
    await expect(readDraft(toolId)).resolves.toBeNull();

    // An unload flush accepted before clearDraft bumps the generation must not queue an
    // IDB put after the delete, even though its store epoch is still current.
    writeDraftNow(toolId, draftData('stale-generation-unload'), { epoch: draftStoreEpoch() });
    const clearing = clearDraft(toolId);
    const cleared = await clearing;
    expect(cleared).toMatchObject({ ok: true, idb: 'ok', localStorage: 'ok', memory: 'ok', partial: false });
    await fake.whenIdle();

    const restored = await readDraft<{ source: string; fileName: string }>(toolId);
    expect({
      localStorage: localStorage.getItem(localKey(toolId)),
      idb: fake.store.has(toolId),
      memory: restored,
    }).toEqual({ localStorage: null, idb: false, memory: null });
  });

  it('REG-G0-304D — a restored retry fully clears copies left by a failed delete', async () => {
    const toolId: ToolId = 'kotoha';
    const data = draftData('retry-after-failure');
    await writeDraft(toolId, data);
    const raw = localStorage.getItem(localKey(toolId));
    const idbRecord = fake.store.get(toolId);
    expect(raw).not.toBeNull();
    expect(idbRecord).toBeDefined();

    const removeItem = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('localStorage removeItem denied');
    });
    fake.control.failDeleteTools.add(toolId);

    const failed = await clearDraft(toolId);
    expect(failed).toEqual({
      ok: false,
      idb: 'failed',
      localStorage: 'failed',
      memory: 'ok',
      partial: true,
      error: expect.stringContaining('IndexedDB'),
    });
    expect(failed.error).toContain('localStorage');
    expect(fake.store.get(toolId)).toBe(idbRecord);
    expect(localStorage.getItem(localKey(toolId))).toBe(raw);

    removeItem.mockRestore();
    fake.control.failDeleteTools.delete(toolId);
    const retried = await clearDraft(toolId);
    expect(retried).toEqual({
      ok: true,
      idb: 'ok',
      localStorage: 'ok',
      memory: 'ok',
      partial: false,
      error: null,
    });
    expect(fake.store.has(toolId)).toBe(false);
    expect(localStorage.getItem(localKey(toolId))).toBeNull();
    await expect(readDraft(toolId)).resolves.toBeNull();
  });

  it('REG-G0-304E — existing v1 records keep their key and database format unchanged', async () => {
    const toolId: ToolId = 'takane';
    const record = {
      version: 1,
      toolId,
      savedAt: '2026-11-01T02:03:04.000Z',
      data: { source: 'existing v1 source', fileName: 'existing-v1.md', framework: 'go' },
    };
    const raw = JSON.stringify(record);
    localStorage.setItem(localKey(toolId), raw);
    fake.store.set(toolId, record);

    expect(readDraftSync<typeof record.data>(toolId)).toEqual(record);
    await expect(readDraft<typeof record.data>(toolId)).resolves.toEqual({
      data: record.data,
      savedAt: record.savedAt,
      storage: 'indexeddb',
    });

    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe(localKey(toolId));
    expect(localStorage.getItem(localKey(toolId))).toBe(raw);
    expect(fake.openCalls).toEqual([{ name: 'adop0001-drafts', version: 1 }]);
    expect(fake.transactionStores).toEqual(['drafts']);
    expect(fake.store.size).toBe(1);
    expect(fake.store.get(toolId)).toBe(record);
  });

  it('REG-G0-304F — a readback exception after removeItem does not report retained data', async () => {
    const toolId: ToolId = 'shiori';
    await writeDraft(toolId, draftData('readback-denied'));
    const originalGetItem = localStorage.getItem.bind(localStorage);
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation((key: string) => {
      if (key === localKey(toolId)) throw new Error('localStorage readback denied');
      return originalGetItem(key);
    });

    const result = await clearDraft(toolId);
    expect(result).toMatchObject({ ok: true, idb: 'ok', localStorage: 'ok', memory: 'ok', partial: false });
    getItem.mockRestore();
    expect(localStorage.getItem(localKey(toolId))).toBeNull();
    expect(fake.store.has(toolId)).toBe(false);
  });
});
