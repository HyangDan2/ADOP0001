/**
 * WO-OPS-01B — production storage names are frozen; beta names are disjoint.
 * These are the exact names found across the source tree at the time of the
 * change, so a future key that forgets the namespace shows up here.
 */
import { describe, expect, it } from 'vitest';
import { namespaceDbName, namespaceKey } from '../src/lib/channel';

const KEYS = [
  'adop0001.theme',
  'adop0001.workspace.open',
  'adop0001.engine.mode',
  'adop0001.draft.shiori',
  'adop0001.prompt.shiori',
  'adop0001.fewshot.v1',
  'adop0001.shiori.latest',
  'adop0001.kotoha.presets',
  'adop0001.hybrid.connection',
  'adop0001.hybrid.providers.v1',
  'adop0001.hybrid.redaction.v1',
];

const DBS = [
  'adop0001-artifacts',
  'adop0001-drafts',
  'adop0001-project-index',
  'adop0001-kotoha',
  'adop0001_fewshot_v1',
];

describe('channel storage namespaces', () => {
  it('leaves every production key and database name untouched', () => {
    for (const key of KEYS) expect(namespaceKey(key, 'production')).toBe(key);
    for (const name of DBS) expect(namespaceDbName(name, 'production')).toBe(name);
  });

  it('maps beta keys under one prefix without collisions', () => {
    const beta = KEYS.map((key) => namespaceKey(key, 'beta'));
    expect(new Set(beta).size).toBe(KEYS.length);
    expect(namespaceKey('adop0001.theme', 'beta')).toBe('adop0001.beta.theme');
    for (const key of beta) expect(key.startsWith('adop0001.beta.')).toBe(true);
    for (const key of beta) expect(KEYS).not.toContain(key);
  });

  it('maps beta databases with the same separator as the production name', () => {
    expect(namespaceDbName('adop0001-artifacts', 'beta')).toBe('adop0001-beta-artifacts');
    expect(namespaceDbName('adop0001_fewshot_v1', 'beta')).toBe('adop0001_beta_fewshot_v1');
    expect(namespaceDbName('adop0001.project-index', 'beta')).toBe('adop0001.beta.project-index');
    for (const name of DBS) expect(namespaceDbName(name, 'beta')).not.toBe(name);
  });
});