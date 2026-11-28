/**
 * Few-shot example store (Option B groundwork).
 *
 * Examples live in this browser only: IndexedDB `adop0001_fewshot_v1` is the
 * primary store, `localStorage` and an in-memory map are fallbacks so tests and
 * private-browsing sessions still work. Nothing here performs a network call.
 */
import type { FewShotExample, PromptStrategy, ToolId } from '../adapters/types';
import { databaseName, storageKey } from './channel';

export const FEW_SHOT_DB_NAME = databaseName('adop0001_fewshot_v1');
export const FEW_SHOT_OBJECT_STORE = 'examples';
export const FEW_SHOT_BUNDLE_KIND = 'adop0001.fewshot';
export const FEW_SHOT_BUNDLE_VERSION = 1;
const LOCAL_STORAGE_KEY = storageKey('adop0001.fewshot.v1');

export type FewShotStorage = 'indexeddb' | 'localstorage' | 'memory';

/** The only tools an example may belong to (DATA-001). */
export const FEW_SHOT_TOOL_IDS = ['shiori', 'yayoi', 'kozue', 'haruhi', 'kotoha', 'takane'] as const;

export function isFewShotToolId(value: unknown): value is ToolId {
  return typeof value === 'string' && (FEW_SHOT_TOOL_IDS as readonly string[]).includes(value);
}

/**
 * Import limits. They exist so a hostile or broken bundle cannot fill the store,
 * freeze the tab while it is parsed, or smuggle oversized metadata into a future
 * AI request. The numbers are deliberately generous for hand-written examples.
 */
export const FEW_SHOT_LIMITS = {
  /** Bytes of the whole .fewshot.json file. */
  bundleBytes: 512 * 1024,
  /** Bytes of one example's input plus output text. */
  exampleBytes: 128 * 1024,
  /** Examples one bundle may carry. */
  examples: 100,
  /** Examples kept in this browser in total. */
  storedExamples: 500,
  /** Estimated tokens of one example (input + output). */
  exampleTokens: 20_000,
  /** Characters in a title. */
  titleChars: 200,
  /** Characters in an id; imported ids become IndexedDB keys. */
  idChars: 120,
} as const;

/** Human-readable storage backend, used by the UI warning when IndexedDB is gone. */
export function describeStorage(storage: FewShotStorage): string {
  switch (storage) {
    case 'indexeddb':
      return 'IndexedDB';
    case 'localstorage':
      return 'localStorage（IndexedDB を利用できません）';
    default:
      return 'メモリのみ（このタブを閉じると消えます）';
  }
}

export interface FewShotDraft {
  id?: string;
  toolId: ToolId;
  title: string;
  inputFileName?: string;
  inputText?: string;
  outputFileName?: string;
  outputText: string;
  targetLanguage?: string;
  enabled?: boolean;
}

export interface FewShotBundle {
  kind: typeof FEW_SHOT_BUNDLE_KIND;
  version: number;
  exportedAt: string;
  examples: FewShotExample[];
}

const memory = new Map<string, FewShotExample>();
let cache: Map<string, FewShotExample> | null = null;

/* ------------------------------------------------------------------ */
/* Token estimation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Deterministic token estimate used for budgeting and the UI counter.
 * ASCII text counts four characters per token, wider (CJK) text about 1.6
 * characters per token. No tokenizer is downloaded.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + wide / 1.6));
}

/** Token cost of injecting one example into a prompt. */
export function exampleTokenCost(example: Pick<FewShotExample, 'inputText' | 'outputText'>): number {
  return estimateTokens(example.inputText ?? '') + estimateTokens(example.outputText ?? '');
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const request = indexedDB.open(FEW_SHOT_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(FEW_SHOT_OBJECT_STORE)) {
          db.createObjectStore(FEW_SHOT_OBJECT_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

type StorageListener = (storage: FewShotStorage) => void;
let storageListener: StorageListener | null = null;

/**
 * DATA-001 — surfaces a failed IndexedDB write.
 *
 * The store silently falls back to localStorage or memory; without a listener the
 * user would believe the example was saved to disk. The manager modal subscribes
 * and shows the backend whenever it is not IndexedDB.
 */
export function onFewShotStorageChange(listener: StorageListener | null): void {
  storageListener = listener;
}

function readLocalStorage(): FewShotExample[] | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as FewShotExample[]) : [];
  } catch {
    return null;
  }
}

function writeLocalStorage(examples: FewShotExample[]): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(examples));
    return true;
  } catch {
    return false;
  }
}

async function readIndexedDb(): Promise<FewShotExample[] | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<FewShotExample[] | null>((resolve) => {
      const transaction = db.transaction(FEW_SHOT_OBJECT_STORE, 'readonly');
      const request = transaction.objectStore(FEW_SHOT_OBJECT_STORE).getAll();
      request.onsuccess = () => resolve((request.result as FewShotExample[]) ?? []);
      request.onerror = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

async function writeIndexedDb(examples: FewShotExample[]): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  try {
    return await new Promise<boolean>((resolve) => {
      const transaction = db.transaction(FEW_SHOT_OBJECT_STORE, 'readwrite');
      const store = transaction.objectStore(FEW_SHOT_OBJECT_STORE);
      store.clear();
      for (const example of examples) store.put(example);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    });
  } finally {
    db.close();
  }
}

async function load(): Promise<Map<string, FewShotExample>> {
  if (cache) return cache;
  const fromIdb = await readIndexedDb();
  if (fromIdb) {
    cache = new Map(fromIdb.map((example) => [example.id, example]));
    return cache;
  }
  const fromLocal = readLocalStorage();
  if (fromLocal) {
    cache = new Map(fromLocal.map((example) => [example.id, example]));
    return cache;
  }
  cache = new Map(memory);
  return cache;
}

async function persist(): Promise<FewShotStorage> {
  const examples = [...(cache ?? new Map<string, FewShotExample>()).values()];
  const storage = await writeThrough(examples);
  storageListener?.(storage);
  return storage;
}

async function writeThrough(examples: FewShotExample[]): Promise<FewShotStorage> {
  if (await writeIndexedDb(examples)) return 'indexeddb';
  if (writeLocalStorage(examples)) return 'localstorage';
  memory.clear();
  for (const example of examples) memory.set(example.id, example);
  return 'memory';
}

/** Which backend the last write reached. Accessing `localStorage` can throw. */
export async function fewShotStorage(): Promise<FewShotStorage> {
  const db = await openDb();
  if (db) {
    db.close();
    return 'indexeddb';
  }
  try {
    return typeof localStorage === 'undefined' ? 'memory' : 'localstorage';
  } catch {
    return 'memory';
  }
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `fs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed ? value : undefined;
}

function optionalName(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed || undefined;
}

function normaliseTitle(draft: FewShotDraft): string {
  const title = draft.title.trim();
  if (title) return title;
  const fromOutput = optionalName(draft.outputFileName);
  if (fromOutput) return fromOutput;
  return draft.outputText.trim().split('\n')[0].slice(0, 60) || 'untitled example';
}

function normalise(draft: FewShotDraft): FewShotExample {
  const inputText = optionalText(draft.inputText);
  const outputText = draft.outputText;
  if (!outputText.trim()) throw new Error('An example needs output text.');
  const role: FewShotExample['role'] = inputText ? 'pair' : 'output';
  const example: FewShotExample = {
    id: draft.id ?? newId(),
    toolId: draft.toolId,
    title: normaliseTitle(draft),
    role,
    outputText,
    enabled: draft.enabled ?? true,
    estimatedTokens: 0,
    updatedAt: new Date().toISOString(),
  };
  if (inputText) example.inputText = inputText;
  const inputFileName = optionalName(draft.inputFileName);
  if (inputFileName) example.inputFileName = inputFileName;
  const outputFileName = optionalName(draft.outputFileName);
  if (outputFileName) example.outputFileName = outputFileName;
  const targetLanguage = optionalName(draft.targetLanguage);
  if (targetLanguage) example.targetLanguage = targetLanguage;
  example.estimatedTokens = exampleTokenCost(example);
  return example;
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

export async function listExamples(toolId?: ToolId): Promise<FewShotExample[]> {
  const all = [...(await load()).values()];
  const filtered = toolId ? all.filter((example) => example.toolId === toolId) : all;
  return filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

export async function saveExample(draft: FewShotDraft): Promise<FewShotExample> {
  if (!isFewShotToolId(draft.toolId)) throw new Error(`Unknown tool id: ${String(draft.toolId)}`);
  const store = await load();
  const example = normalise(draft);
  store.set(example.id, example);
  await persist();
  return example;
}

export async function deleteExample(id: string): Promise<boolean> {
  const store = await load();
  const removed = store.delete(id);
  if (removed) await persist();
  return removed;
}

export async function setExampleEnabled(id: string, enabled: boolean): Promise<FewShotExample | null> {
  const store = await load();
  const existing = store.get(id);
  if (!existing) return null;
  const updated: FewShotExample = { ...existing, enabled, updatedAt: new Date().toISOString() };
  store.set(id, updated);
  await persist();
  return updated;
}

export async function clearExamples(toolId?: ToolId): Promise<number> {
  const store = await load();
  let removed = 0;
  for (const [id, example] of [...store.entries()]) {
    if (!toolId || example.toolId === toolId) {
      store.delete(id);
      removed += 1;
    }
  }
  if (removed) await persist();
  return removed;
}

/** Enabled-example counts per tool, for the top-bar counter. */
export async function activeExampleCounts(): Promise<Record<ToolId, number>> {
  const counts: Record<ToolId, number> = { shiori: 0, yayoi: 0, kozue: 0, haruhi: 0, kotoha: 0, takane: 0 };
  for (const example of await listExamples()) {
    if (example.enabled) counts[example.toolId] += 1;
  }
  return counts;
}

export function totalTokens(examples: FewShotExample[]): number {
  return examples.reduce((sum, example) => sum + example.estimatedTokens, 0);
}

/**
 * Enabled examples that fit `maxTokens`, in most-recently-updated order.
 * Truncation is deterministic: an example that does not fit is skipped and the
 * next smaller one may still enter, so a single huge file cannot crowd out all
 * others.
 */
export function budgetExamples(
  examples: FewShotExample[],
  maxTokens: number,
): { selected: FewShotExample[]; tokens: number; skipped: FewShotExample[] } {
  const selected: FewShotExample[] = [];
  const skipped: FewShotExample[] = [];
  let used = 0;
  for (const example of examples) {
    if (!example.enabled) continue;
    if (used + example.estimatedTokens > maxTokens) {
      skipped.push(example);
      continue;
    }
    selected.push(example);
    used += example.estimatedTokens;
  }
  return { selected, tokens: used, skipped };
}

/* ------------------------------------------------------------------ */
/* Bundle export / import                                              */
/* ------------------------------------------------------------------ */

export function serializeBundle(examples: FewShotExample[], exportedAt = new Date().toISOString()): string {
  const bundle: FewShotBundle = {
    kind: FEW_SHOT_BUNDLE_KIND,
    version: FEW_SHOT_BUNDLE_VERSION,
    exportedAt,
    examples,
  };
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function bundleFileName(toolId: ToolId | 'all'): string {
  return `${toolId}-fewshot.fewshot.json`;
}

const EXAMPLE_KEYS = [
  'id',
  'toolId',
  'title',
  'role',
  'inputFileName',
  'inputText',
  'outputFileName',
  'outputText',
  'targetLanguage',
  'enabled',
  'estimatedTokens',
  'updatedAt',
] as const;

const EXAMPLE_KEY_SET = new Set<string>(EXAMPLE_KEYS);

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function optionalString(item: Record<string, unknown>, key: string, limit: number, label: string): string | undefined {
  const value = item[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Example ${label} has a non-text ${key}.`);
  if (value.length > limit) throw new Error(`Example ${label} has a ${key} that is too long.`);
  return value;
}

/**
 * The single validating entry point for an imported bundle (DATA-001).
 *
 * Everything is checked before a single example reaches the store: bundle size,
 * example count, the tool-id whitelist, field types, unknown metadata, per-example
 * size, token count and duplicate ids. A rejected file leaves the store untouched.
 */
export function parseBundle(json: string): FewShotExample[] {
  if (byteLength(json) > FEW_SHOT_LIMITS.bundleBytes) {
    throw new Error(`The file is larger than ${Math.round(FEW_SHOT_LIMITS.bundleBytes / 1024)} KB.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  const bundle = parsed as Partial<FewShotBundle> & Record<string, unknown>;
  if (!bundle || typeof bundle !== 'object' || bundle.kind !== FEW_SHOT_BUNDLE_KIND) {
    throw new Error(`The file is not a ${FEW_SHOT_BUNDLE_KIND} bundle.`);
  }
  if (typeof bundle.version !== 'number' || bundle.version > FEW_SHOT_BUNDLE_VERSION) {
    throw new Error('The bundle version is newer than this app supports.');
  }
  if (!Array.isArray(bundle.examples)) throw new Error('The bundle has no examples array.');
  if (bundle.examples.length > FEW_SHOT_LIMITS.examples) {
    throw new Error(`The bundle has more than ${FEW_SHOT_LIMITS.examples} examples.`);
  }

  const seen = new Set<string>();
  return bundle.examples.map((raw, index) => {
    const label = `${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Example ${label} is not an object.`);
    }
    const item = raw as unknown as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (!EXAMPLE_KEY_SET.has(key)) {
        throw new Error(`Example ${label} carries an unsupported field: ${key}.`);
      }
    }

    const outputText = item.outputText;
    if (typeof outputText !== 'string' || !outputText.trim()) {
      throw new Error(`Example ${label} has no output text.`);
    }
    if (!isFewShotToolId(item.toolId)) {
      throw new Error(`Example ${label} targets a tool this app does not have.`);
    }
    const inputText = optionalString(item, 'inputText', FEW_SHOT_LIMITS.exampleBytes, label);
    const bytes = byteLength(outputText) + byteLength(inputText ?? '');
    if (bytes > FEW_SHOT_LIMITS.exampleBytes) {
      throw new Error(`Example ${label} is larger than ${Math.round(FEW_SHOT_LIMITS.exampleBytes / 1024)} KB.`);
    }
    const id = optionalString(item, 'id', FEW_SHOT_LIMITS.idChars, label);
    if (id) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Example ${label} has an invalid id.`);
      if (seen.has(id)) throw new Error(`Example ${label} repeats the id ${id}.`);
      seen.add(id);
    }
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      throw new Error(`Example ${label} has a non-boolean enabled flag.`);
    }
    if (item.role !== undefined && item.role !== 'pair' && item.role !== 'output') {
      throw new Error(`Example ${label} has an unknown role.`);
    }
    const claimedTokens = item.estimatedTokens;
    if (claimedTokens !== undefined && (typeof claimedTokens !== 'number' || !Number.isFinite(claimedTokens) || claimedTokens < 0)) {
      throw new Error(`Example ${label} has an invalid token count.`);
    }
    if (typeof claimedTokens === 'number' && claimedTokens > FEW_SHOT_LIMITS.exampleTokens) {
      throw new Error(`Example ${label} claims more than ${FEW_SHOT_LIMITS.exampleTokens} tokens.`);
    }
    if (item.updatedAt !== undefined && (typeof item.updatedAt !== 'string' || !item.updatedAt)) {
      throw new Error(`Example ${label} has an invalid timestamp.`);
    }

    const example = normalise({
      id: id || undefined,
      toolId: item.toolId,
      title: optionalString(item, 'title', FEW_SHOT_LIMITS.titleChars, label) ?? '',
      inputFileName: optionalString(item, 'inputFileName', 260, label),
      inputText,
      outputFileName: optionalString(item, 'outputFileName', 260, label),
      outputText,
      targetLanguage: optionalString(item, 'targetLanguage', 40, label),
      enabled: (item.enabled as boolean | undefined) ?? true,
    });
    // The token count is recomputed from the text; a claimed value is only a
    // sanity check, never trusted for budgeting.
    if (example.estimatedTokens > FEW_SHOT_LIMITS.exampleTokens) {
      throw new Error(`Example ${label} needs more than ${FEW_SHOT_LIMITS.exampleTokens} tokens.`);
    }
    return example;
  });
}

export interface ImportOutcome {
  /** Examples with an id that did not exist before. */
  added: number;
  /** Examples that replaced a stored example with the same id. */
  replaced: number;
  /** Examples the store held after the import. */
  total: number;
  /** Snapshot before the import, for `restoreExamples`. */
  backup: FewShotExample[];
  /** Where the change was written. */
  storage: FewShotStorage;
}

/**
 * Merges parsed examples into the store.
 *
 * Duplicate-id policy: an imported id that already exists **replaces** that
 * example (an exported file can be re-imported as an update); ids are never
 * merged silently across tools. Duplicate ids inside one file are rejected by
 * `parseBundle`. The previous store is returned as `backup` so the UI can offer
 * an immediate undo.
 */
export async function importExamples(examples: FewShotExample[]): Promise<ImportOutcome> {
  const store = await load();
  const backup = [...store.values()];
  const incomingIds = new Set(examples.map((example) => example.id));
  const added = examples.filter((example) => !store.has(example.id)).length;
  const replaced = examples.length - added;
  if (backup.filter((example) => !incomingIds.has(example.id)).length + examples.length > FEW_SHOT_LIMITS.storedExamples) {
    throw new Error(`The store cannot hold more than ${FEW_SHOT_LIMITS.storedExamples} examples.`);
  }
  for (const example of examples) store.set(example.id, example);
  const storage = await persist();
  return { added, replaced, total: store.size, backup, storage };
}

/** Restores a snapshot taken by `importExamples` (one-step undo). */
export async function restoreExamples(backup: FewShotExample[]): Promise<FewShotStorage> {
  const store = await load();
  store.clear();
  for (const example of backup) store.set(example.id, example);
  return persist();
}

/** Test helper: forget the cache and empty every backend. */
export async function resetFewShotStore(): Promise<void> {
  cache = new Map();
  memory.clear();
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LOCAL_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  await writeIndexedDb([]);
}

/* ------------------------------------------------------------------ */
/* Option B prompt assembly preview                                    */
/* ------------------------------------------------------------------ */

export interface PromptShot {
  title: string;
  role: FewShotExample['role'];
  targetLanguage?: string;
  inputFileName?: string;
  outputFileName?: string;
  content: string;
  tokens: number;
}

export interface PromptAssembly {
  strategy: PromptStrategy;
  system: string;
  shots: PromptShot[];
  targetFileName: string;
  targetSource: string;
  tokens: { system: number; shots: number; target: number; total: number };
  /** Enabled examples left out because they exceeded the few-shot cap. */
  skipped: string[];
}

const TOOL_ROLE: Record<ToolId, string> = {
  shiori: 'Specification Writer',
  yayoi: 'Pseudocode Studio',
  kozue: 'UML Auto-Architect',
  haruhi: 'Test Case Forge',
  kotoha: 'Docx to Markdown Round-Trip',
  takane: 'Spec to Code',
};

/** The system instruction the hybrid pass would send for a tool. */
export function systemPromptFor(toolId: ToolId): string {
  const role = TOOL_ROLE[toolId];
  return [
    `You are the ${role} engine of HD2Lab Aomatsukan, a developer tool suite.`,
    'Follow the reference examples exactly: same ordering, naming, comment style and formatting.',
    'Local static analysis stays authoritative; only fill gaps the reference examples justify.',
    'Answer in English only, with no commentary, no markdown fences and no apologies.',
  ].join('\n');
}

export function assemblePromptPreview(params: {
  toolId: ToolId;
  examples: FewShotExample[];
  source: string;
  sourceName: string;
  maxFewShotTokens?: number;
}): PromptAssembly {
  const cap = params.maxFewShotTokens ?? 2000;
  const ordered = params.examples.filter((example) => example.enabled);
  const { selected, skipped, tokens: shotTokens } = budgetExamples(ordered, cap);
  const system = systemPromptFor(params.toolId);
  const shots: PromptShot[] = selected.map((example) => ({
    title: example.title,
    role: example.role,
    targetLanguage: example.targetLanguage,
    inputFileName: example.inputFileName,
    outputFileName: example.outputFileName,
    content: example.inputText
      ? `INPUT:\n${example.inputText.trim()}\n\nOUTPUT:\n${example.outputText.trim()}`
      : `OUTPUT:\n${example.outputText.trim()}`,
    tokens: example.estimatedTokens,
  }));
  const target = params.source.trim();
  const systemTokens = estimateTokens(system);
  const targetTokens = estimateTokens(target);
  return {
    strategy: selected.length ? 'few-shot' : 'zero-shot',
    system,
    shots,
    targetFileName: params.sourceName,
    targetSource: target,
    tokens: {
      system: systemTokens,
      shots: shotTokens,
      target: targetTokens,
      total: systemTokens + shotTokens + targetTokens,
    },
    skipped: skipped.map((example) => example.title),
  };
}

/** Renders the assembly exactly as the request body would carry it. */
export function renderPromptText(assembly: PromptAssembly): string {
  const lines: string[] = [];
  lines.push(`# strategy: ${assembly.strategy}`);
  lines.push('', '## system', assembly.system, '');
  if (assembly.shots.length) {
    lines.push(`## examples (${assembly.shots.length})`);
    for (const shot of assembly.shots) {
      const label = [`[${shot.role}]`, shot.title, shot.targetLanguage ? `(${shot.targetLanguage})` : '']
        .filter(Boolean)
        .join(' ');
      lines.push('', `### ${label}`, shot.content);
    }
    lines.push('');
  } else {
    lines.push('## examples (0)', 'No enabled example is selected; the request is zero-shot.', '');
  }
  if (assembly.skipped.length) {
    lines.push(`## skipped (over the few-shot budget): ${assembly.skipped.join(', ')}`, '');
  }
  lines.push(`## target source (${assembly.targetFileName})`, assembly.targetSource || '(empty)');
  return lines.join('\n');
}
