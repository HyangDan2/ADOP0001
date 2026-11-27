/**
 * CP01-FIX-02 vectors: the four hashes, canonical JSON storage, and the fact
 * that random ids/timestamps are not part of content identity.
 */
import { describe, expect, it } from 'vitest';
import {
  buildContentDigest,
  buildRevisionIntegrityHash,
  canonicalJsonPayload,
  decodeContentPayload,
  exportByteHash,
  hashContentPayload,
  sha256Hex,
} from '../../../src/lib/artifacts/hash';
import { draft, PROVENANCE_HASH, SOURCE_HASH, INPUT_FINGERPRINT } from './helpers';

const HEX = /^[0-9a-f]{64}$/;

describe('artifact hash policy', () => {
  it('matches SHA-256 test vectors', async () => {
    expect(await sha256Hex(new TextEncoder().encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes decoded bytes, so text and its base64 form agree', async () => {
    const text = await hashContentPayload({
      contentType: 'text/plain',
      encoding: 'utf8',
      payload: 'abc',
    });
    const binary = await hashContentPayload({
      contentType: 'text/plain',
      encoding: 'base64',
      payload: Buffer.from('abc').toString('base64'),
    });
    expect(binary.contentHash).toBe(text.contentHash);
    expect(binary.payload).toBe('YWJj');
    expect(decodeContentPayload('base64', 'YWJj')).toEqual(text.bytes);
    expect(text.byteLength).toBe(3);
    expect(text.contentHash).toMatch(HEX);
  });

  it('stores and hashes JSON as canonical JSON', async () => {
    const prepared = await hashContentPayload({
      contentType: 'application/json',
      encoding: 'utf8',
      payload: '{"b":1,"a":{"d":2,"c":[3,2]}}',
    });
    expect(prepared.payload).toBe('{"a":{"c":[3,2],"d":2},"b":1}');
    expect(canonicalJsonPayload('{"z":1,"y":2}')).toBe('{"y":2,"z":1}');
    expect(prepared.contentHash).toBe(
      await sha256Hex(new TextEncoder().encode(prepared.payload)),
    );
  });

  it('rejects invalid base64 and invalid JSON payloads', async () => {
    await expect(
      hashContentPayload({ contentType: 'text/plain', encoding: 'base64', payload: '***' }),
    ).rejects.toThrow(/base64/);
    await expect(
      hashContentPayload({ contentType: 'application/json', encoding: 'utf8', payload: '{' }),
    ).rejects.toThrow(/valid JSON/);
  });

  it('content digest excludes entry ids and only reflects the semantic set', async () => {
    const first = await hashContentPayload({
      contentType: 'text/markdown',
      encoding: 'utf8',
      payload: '# A',
    });
    const second = await hashContentPayload({
      contentType: 'text/plain',
      encoding: 'utf8',
      payload: 'notes',
    });
    const base = {
      schemaVersion: '1.0.0' as const,
      artifactType: 'uml-diagram' as const,
      entries: [
        {
          order: 1,
          role: 'diagram-source' as const,
          contentType: 'text/x-mermaid' as const,
          contentHash: second.contentHash,
          byteLength: second.byteLength,
        },
        {
          order: 0,
          role: 'primary' as const,
          contentType: 'text/markdown' as const,
          contentHash: first.contentHash,
          byteLength: first.byteLength,
        },
      ],
    };
    const digestA = await buildContentDigest(base);
    const digestB = await buildContentDigest({
      ...base,
      entries: [...base.entries].reverse(),
    });
    expect(digestA).toBe(digestB);
    expect(digestA).toMatch(HEX);

    const reordered = await buildContentDigest({
      ...base,
      entries: [
        { ...base.entries[0], order: 0 },
        { ...base.entries[1], order: 1 },
      ],
    });
    expect(reordered).not.toBe(digestA);
  });

  it('rejects duplicate content order values', async () => {
    const content = await hashContentPayload({
      contentType: 'text/plain',
      encoding: 'utf8',
      payload: 'x',
    });
    await expect(
      buildContentDigest({
        schemaVersion: '1.0.0',
        artifactType: 'specification',
        entries: [
          {
            order: 0,
            role: 'primary',
            contentType: 'text/plain',
            contentHash: content.contentHash,
            byteLength: content.byteLength,
          },
          {
            order: 0,
            role: 'alternate',
            contentType: 'text/plain',
            contentHash: content.contentHash,
            byteLength: content.byteLength,
          },
        ],
      }),
    ).rejects.toThrow(/Duplicate content order/);
  });

  it('revision hash separates content, parent, source identity, and restore lineage', async () => {
    const prepared = await hashContentPayload({
      contentType: 'text/markdown',
      encoding: 'utf8',
      payload: '# Same content',
    });
    const contentDigest = await buildContentDigest({
      schemaVersion: '1.0.0',
      artifactType: 'specification',
      entries: [
        {
          order: 0,
          role: 'primary',
          contentType: 'text/markdown',
          contentHash: prepared.contentHash,
          byteLength: prepared.byteLength,
        },
      ],
    });
    const baseDraft = draft();
    const base = {
      schemaVersion: '1.0.0' as const,
      artifactType: 'specification' as const,
      contentDigest,
      sourceRevision: baseDraft.sourceRevision,
      parentRevisionId: null,
      engineVersion: baseDraft.engineVersion,
      providerMode: baseDraft.providerMode,
      dependencies: baseDraft.dependencies,
      provenance: baseDraft.provenance,
    };
    const baseHash = await buildRevisionIntegrityHash(base);
    expect(baseHash).toMatch(HEX);
    expect(
      await buildRevisionIntegrityHash({
        ...base,
        sourceRevision: { ...base.sourceRevision, sourceName: 'renamed.md' },
      }),
    ).not.toBe(baseHash);
    expect(
      await buildRevisionIntegrityHash({ ...base, parentRevisionId: 'rev_parent' }),
    ).not.toBe(baseHash);
    expect(
      await buildRevisionIntegrityHash({
        ...base,
        provenance: { ...base.provenance, cacheKey: 'cached' },
      }),
    ).not.toBe(baseHash);
    expect(
      await buildRevisionIntegrityHash({ ...base, restoredFromRevisionId: 'rev_old' }),
    ).not.toBe(baseHash);
    expect(
      await buildRevisionIntegrityHash({
        ...base,
        sourceRevision: {
          inputRevision: 1,
          inputFingerprint: INPUT_FINGERPRINT,
          sourceName: 'spec.md',
          sourceHash: SOURCE_HASH,
        },
        provenance: { ...base.provenance, sourceHash: PROVENANCE_HASH },
      }),
    ).toBe(baseHash);
  });

  it('deduplicates and orders dependencies before hashing', async () => {
    const baseDraft = draft();
    const digest = 'd'.repeat(64);
    const one = await buildRevisionIntegrityHash({
      schemaVersion: '1.0.0',
      artifactType: 'specification',
      contentDigest: digest,
      sourceRevision: baseDraft.sourceRevision,
      parentRevisionId: null,
      engineVersion: baseDraft.engineVersion,
      providerMode: baseDraft.providerMode,
      dependencies: [
        { artifactId: 'b', revisionId: 'r2', relation: 'packages' },
        { artifactId: 'a', revisionId: 'r1', relation: 'validates' },
        { artifactId: 'b', revisionId: 'r2', relation: 'packages' },
      ],
      provenance: baseDraft.provenance,
    });
    const two = await buildRevisionIntegrityHash({
      schemaVersion: '1.0.0',
      artifactType: 'specification',
      contentDigest: digest,
      sourceRevision: baseDraft.sourceRevision,
      parentRevisionId: null,
      engineVersion: baseDraft.engineVersion,
      providerMode: baseDraft.providerMode,
      dependencies: [
        { artifactId: 'a', revisionId: 'r1', relation: 'validates' },
        { artifactId: 'b', revisionId: 'r2', relation: 'packages' },
      ],
      provenance: baseDraft.provenance,
    });
    expect(one).toBe(two);
  });

  it('export byte hash covers exactly the written bytes', async () => {
    const bytes = new TextEncoder().encode('<svg/>');
    expect(await exportByteHash(bytes)).toBe(await sha256Hex(bytes));
    expect(await exportByteHash(bytes)).not.toBe(
      await exportByteHash(new TextEncoder().encode('<svg />')),
    );
  });
});
