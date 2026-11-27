/**
 * Q05 E2E helper unit tests.
 *
 * The helpers live under `tests/e2e/artifacts/helpers` (vitest excludes that
 * tree), so their executable checks live here. The helpers are Playwright-free
 * by construction: they accept structural observers/evaluators, which lets this
 * file exercise the real logic without a browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_BASE_PATH,
  ARTIFACTS_E2E_PORT,
  MAIN_PREVIEW_PORT,
  artifactsBaseUrl,
  assertDedicatedE2EPort,
  originOf,
} from '../../e2e/artifacts/helpers/port';
import {
  classifyRequest,
  createNetworkLog,
  type RequestListener,
  type RequestObserver,
} from '../../e2e/artifacts/helpers/networkLog';
import {
  ARTIFACT_DB_NAME,
  ARTIFACT_STORE_NAMES,
  diffDumps,
  dumpArtifactDb,
  readArtifactDbInPage,
  stableKey,
  storeCounts,
  type ArtifactDbDump,
  type EvaluatorLike,
} from '../../e2e/artifacts/helpers/idbDump';
import { createTwoTabHarness, type PageLike } from '../../e2e/artifacts/helpers/twoTab';

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

afterEach(() => {
  if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
  else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
});

/* ------------------------------------------------------------------ */
/* Port isolation                                                      */
/* ------------------------------------------------------------------ */

describe('artifact E2E port isolation', () => {
  it('defaults to the dedicated port and app path', () => {
    expect(ARTIFACTS_E2E_PORT).not.toBe(MAIN_PREVIEW_PORT);
    expect(artifactsBaseUrl()).toBe(`http://127.0.0.1:${ARTIFACTS_E2E_PORT}${APP_BASE_PATH}`);
    expect(originOf(artifactsBaseUrl())).toBe(`http://127.0.0.1:${ARTIFACTS_E2E_PORT}`);
  });

  it('refuses the main preview port', () => {
    expect(() => assertDedicatedE2EPort(MAIN_PREVIEW_PORT)).toThrow(/not a dedicated run/);
    expect(() => assertDedicatedE2EPort(`http://127.0.0.1:${MAIN_PREVIEW_PORT}/ADOP0001/`)).toThrow(
      /not a dedicated run/,
    );
  });

  it('accepts another explicit high port and rejects garbage', () => {
    expect(assertDedicatedE2EPort(4300)).toBe(4300);
    expect(artifactsBaseUrl(4300)).toContain(':4300');
    expect(() => assertDedicatedE2EPort(80)).toThrow(/integer in/);
    expect(() => assertDedicatedE2EPort(70_000)).toThrow(/integer in/);
  });
});

/* ------------------------------------------------------------------ */
/* Network log                                                         */
/* ------------------------------------------------------------------ */

function fakeEmitter() {
  const listeners: RequestListener[] = [];
  const observer: RequestObserver & { emit(url: string): void } = {
    on: (_event, listener) => {
      listeners.push(listener);
      return undefined;
    },
    off: (_event, listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(url: string) {
      for (const listener of [...listeners]) listener({ url: () => url });
    },
  };
  return { observer, listenerCount: () => listeners.length };
}

describe('context request log (REG-G1-20)', () => {
  const allowed = ['http://127.0.0.1:4273'];

  it('classifies app, local-only, and external URLs', () => {
    expect(classifyRequest('http://127.0.0.1:4273/ADOP0001/assets/app.js', allowed).external).toBe(false);
    expect(classifyRequest('data:text/plain,hi', allowed).external).toBe(false);
    expect(classifyRequest('blob:http://127.0.0.1:4273/abc', allowed).external).toBe(false);

    const gateway = classifyRequest('https://api.example.invalid/v1/chat/completions', allowed);
    expect(gateway.external).toBe(true);
    expect(gateway.origin).toBe('https://api.example.invalid');
    expect(classifyRequest('wss://relay.example.invalid/socket', allowed).external).toBe(true);
    expect(classifyRequest('not a url', allowed).external).toBe(true);
  });

  it('counts every request and fails on a non-app origin', () => {
    const { observer } = fakeEmitter();
    const log = createNetworkLog(observer, { allowedOrigins: allowed, pageLabel: 'tab-a' });
    observer.emit('http://127.0.0.1:4273/ADOP0001/');
    observer.emit('http://127.0.0.1:4273/ADOP0001/assets/index.js');
    expect(log.total()).toBe(2);
    expect(log.external()).toEqual([]);
    expect(() => log.assertNoExternalRequests()).not.toThrow();

    observer.emit('https://api.example.invalid/v1/chat/completions');
    expect(log.total()).toBe(3);
    expect(log.external()).toHaveLength(1);
    expect(log.origins()).toEqual(['http://127.0.0.1:4273', 'https://api.example.invalid']);
    expect(() => log.assertNoExternalRequests()).toThrow(/api\.example\.invalid/);
  });

  it('stops observing after stop() and can reset its buffer', () => {
    const { observer, listenerCount } = fakeEmitter();
    const log = createNetworkLog(observer, { allowedOrigins: allowed });
    observer.emit('http://127.0.0.1:4273/ADOP0001/');
    log.reset();
    expect(log.total()).toBe(0);
    log.stop();
    expect(listenerCount()).toBe(0);
    observer.emit('https://api.example.invalid/x');
    expect(log.total()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* IndexedDB dump                                                      */
/* ------------------------------------------------------------------ */

function installFakeIndexedDb(
  stores: Record<string, unknown[]>,
  options: { failOpen?: boolean } = {},
) {
  const closed = vi.fn();
  const db = {
    version: 1,
    objectStoreNames: { contains: (name: string) => name in stores },
    transaction: () => {
      const transaction = {
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        objectStore: (name: string) => ({
          getAll: () => {
            const request = { result: stores[name] ?? [], onsuccess: null as (() => void) | null };
            setTimeout(() => request.onsuccess?.(), 0);
            return request;
          },
        }),
      };
      setTimeout(() => transaction.oncomplete?.(), 5);
      return transaction;
    },
    close: closed,
  };
  const factory = {
    open: () => {
      const request = {
        result: db,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      };
      setTimeout(() => {
        if (options.failOpen) request.onerror?.();
        else request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: factory as unknown as IDBFactory,
  });
  return { closed };
}

describe('artifact IndexedDB dump (REG-G1-10/11)', () => {
  it('reads the frozen store names and reports counts', async () => {
    const fake = installFakeIndexedDb({
      artifacts: [{ artifactId: 'art_1' }],
      revisions: [{ revisionId: 'rev_1' }, { revisionId: 'rev_2' }],
      meta: [{ key: 'scopeEpoch', value: 1 }],
    });

    const dump = await readArtifactDbInPage({ dbName: ARTIFACT_DB_NAME, storeNames: ARTIFACT_STORE_NAMES });
    expect(dump?.dbName).toBe('adop0001-artifacts');
    expect(dump?.version).toBe(1);
    expect(dump?.stores.revisions).toHaveLength(2);
    expect(storeCounts(dump)).toEqual({ artifacts: 1, revisions: 2, meta: 1 });
    expect(fake.closed).toHaveBeenCalledTimes(1);
  });

  it('returns null when IndexedDB is absent or refuses to open', async () => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    expect(await readArtifactDbInPage({ dbName: ARTIFACT_DB_NAME, storeNames: ARTIFACT_STORE_NAMES })).toBeNull();

    installFakeIndexedDb({}, { failOpen: true });
    expect(await readArtifactDbInPage({ dbName: ARTIFACT_DB_NAME, storeNames: ARTIFACT_STORE_NAMES })).toBeNull();
  });

  it('passes the database name and store list through the evaluator', async () => {
    const seen: { dbName: string; storeNames: readonly string[] }[] = [];
    const evaluator: EvaluatorLike = {
      async evaluate(pageFunction, arg) {
        seen.push(arg);
        return pageFunction(arg);
      },
    };
    installFakeIndexedDb({ artifacts: [] });
    const dump = await dumpArtifactDb(evaluator);
    expect(seen).toHaveLength(1);
    expect(seen[0].dbName).toBe(ARTIFACT_DB_NAME);
    expect(seen[0].storeNames).toEqual([...ARTIFACT_STORE_NAMES]);
    expect(dump?.stores.artifacts).toEqual([]);

    await dumpArtifactDb(evaluator, { dbName: 'other-db', storeNames: ['meta'] });
    expect(seen[1]).toEqual({ dbName: 'other-db', storeNames: ['meta'] });
  });

  it('diffs appends and removals independently of key order', () => {
    const before: ArtifactDbDump = {
      dbName: ARTIFACT_DB_NAME,
      version: 1,
      stores: { revisions: [{ revisionId: 'rev_1', ordinal: 1 }] },
    };
    const after: ArtifactDbDump = {
      dbName: ARTIFACT_DB_NAME,
      version: 1,
      stores: { revisions: [{ ordinal: 1, revisionId: 'rev_1' }, { revisionId: 'rev_2', ordinal: 2 }] },
    };

    expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
    const diff = diffDumps(before, after);
    expect(diff.added.revisions).toEqual([{ revisionId: 'rev_2', ordinal: 2 }]);
    expect(diff.removed).toEqual({});

    const reversed = diffDumps(after, before);
    expect(reversed.removed.revisions).toEqual([{ revisionId: 'rev_2', ordinal: 2 }]);
    expect(reversed.added).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* Two-tab harness                                                     */
/* ------------------------------------------------------------------ */

interface FakePage extends PageLike {
  close: () => Promise<void>;
}

describe('two-tab harness (REG-G1-17)', () => {
  function makeContext() {
    const pages: FakePage[] = [];
    const context = {
      newPage: async () => {
        const page: FakePage = { close: vi.fn(async () => undefined) };
        pages.push(page);
        return page;
      },
    };
    return { context, pages };
  }

  it('opens labelled pages and rejects duplicate labels', async () => {
    const { context, pages } = makeContext();
    const harness = createTwoTabHarness(context);
    await harness.open('a');
    await harness.open('b');
    expect(pages).toHaveLength(2);
    expect([...harness.pages().keys()]).toEqual(['a', 'b']);
    await expect(harness.open('a')).rejects.toThrow(/already has a page/);
  });

  it('runs both routines concurrently and reports each outcome', async () => {
    const { context } = makeContext();
    const harness = createTwoTabHarness(context);
    await harness.open('a');
    await harness.open('b');

    const started: string[] = [];
    const release: Record<string, () => void> = {};
    const pending = harness.run(['a', 'b'], async (_page, label) => {
      started.push(label);
      await new Promise<void>((resolve) => {
        release[label] = resolve;
      });
      if (label === 'b') throw new Error('pointer conflict');
      return `${label}-done`;
    });

    expect(started).toEqual(['a', 'b']);
    release.a();
    release.b();

    const [first, second] = await pending;
    expect(first).toMatchObject({ label: 'a', status: 'fulfilled', value: 'a-done' });
    expect(second.status).toBe('rejected');
    expect(second.error).toContain('pointer conflict');
  });

  it('rejects a run against an unopened label', async () => {
    const { context } = makeContext();
    const harness = createTwoTabHarness(context);
    await harness.open('a');
    await expect(harness.run(['a', 'b'], async () => 'x')).rejects.toThrow(/no open page labelled "b"/);
  });

  it('closes every page once and survives a close failure', async () => {
    const { context, pages } = makeContext();
    const harness = createTwoTabHarness(context);
    await harness.open('a');
    await harness.open('b');
    pages[0].close = vi.fn(async () => {
      throw new Error('already closed');
    });

    await harness.closeAll();
    expect(pages[1].close).toHaveBeenCalledTimes(1);
    expect(pages[0].close).toHaveBeenCalledTimes(1);
    expect(harness.pages().size).toBe(0);
    await harness.closeAll();
    expect(pages[1].close).toHaveBeenCalledTimes(1);
  });
});
