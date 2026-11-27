/**
 * WO-D07 revision diff: line hunks, pairing, binary handling and the budget.
 */
import { describe, expect, it } from 'vitest';
import type { ArtifactRevision } from '../../../src/engine/artifacts/types';
import { diffRevisions, diffText } from '../../../src/engine/artifacts/diff';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function revision(contents: ArtifactRevision['contents'], overrides: Partial<ArtifactRevision> = {}): ArtifactRevision {
  return {
    revisionId: 'rev_1',
    artifactId: 'art_1',
    ordinal: 1,
    parentRevisionId: null,
    createdAt: '2026-11-27T00:00:00.000Z',
    contents,
    contentDigest: HASH_A,
    revisionHash: HASH_B,
    sourceRevision: {
      inputRevision: 1,
      inputFingerprint: HASH_A,
      sourceName: 'spec.ts',
      sourceHash: HASH_B,
    },
    engineVersion: '5b.2',
    providerMode: 'local-static',
    diagnostics: [],
    dependencies: [],
    provenance: {
      toolId: 'shiori',
      engineVersion: '5b.2',
      providerMode: 'local-static',
      sourceHash: HASH_B,
    },
    ...overrides,
  };
}

describe('text diff', () => {
  it('reports added and removed lines with hunk coordinates', () => {
    const result = diffText('# Title\none\ntwo\nthree\n', '# Title\none\nTWO\nthree\nfour\n');
    expect(result.added).toBe(2);
    expect(result.removed).toBe(1);
    const lines = result.hunks.flatMap((hunk) => hunk.lines);
    expect(lines.some((line) => line.kind === 'remove' && line.text === 'two')).toBe(true);
    expect(lines.some((line) => line.kind === 'add' && line.text === 'TWO')).toBe(true);
    expect(lines.some((line) => line.kind === 'add' && line.text === 'four')).toBe(true);
    expect(result.hunks[0].leftStart).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('is empty for identical text and collapses far-apart changes into hunks', () => {
    expect(diffText('a\nb\n', 'a\nb\n').hunks).toEqual([]);
    const many = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');
    const changed = many.replace('line 2', 'line two').replace('line 38', 'line thirty-eight');
    const result = diffText(many, changed, { context: 1 });
    expect(result.hunks).toHaveLength(2);
  });

  it('falls back to a whole-block diff beyond the line budget', () => {
    const left = Array.from({ length: 10 }, (_, index) => `a${index}`).join('\n');
    const right = Array.from({ length: 10 }, (_, index) => `b${index}`).join('\n');
    const result = diffText(left, right, { maxLines: 4 });
    expect(result.truncated).toBe(true);
    expect(result.removed).toBe(10);
    expect(result.added).toBe(10);
  });
});

describe('revision diff', () => {
  it('pairs entries by role/variant/type and compares binary by hash', () => {
    const left = revision([
      {
        contentId: 'c1',
        order: 1,
        role: 'primary',
        contentType: 'text/markdown',
        encoding: 'utf8',
        payload: '# A\none\n',
        contentHash: HASH_A,
        byteLength: 8,
      },
      {
        contentId: 'c2',
        order: 2,
        role: 'primary',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        encoding: 'base64',
        fileName: 'doc.docx',
        payload: 'UEsDBA==',
        contentHash: HASH_A,
        byteLength: 4,
      },
    ]);
    const right = revision(
      [
        {
          contentId: 'c3',
          order: 1,
          role: 'primary',
          contentType: 'text/markdown',
          encoding: 'utf8',
          payload: '# A\none\ntwo\n',
          contentHash: HASH_B,
          byteLength: 12,
        },
        {
          contentId: 'c4',
          order: 2,
          role: 'primary',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          encoding: 'base64',
          fileName: 'doc.docx',
          payload: 'UEsDBA==',
          contentHash: HASH_A,
          byteLength: 4,
        },
        {
          contentId: 'c5',
          order: 3,
          role: 'metadata',
          contentType: 'application/json',
          encoding: 'utf8',
          payload: '{}',
          contentHash: HASH_B,
          byteLength: 2,
        },
      ],
      { revisionId: 'rev_2', ordinal: 2 },
    );
    const result = diffRevisions(left, right);
    expect(result.leftRevisionId).toBe('rev_1');
    expect(result.rightRevisionId).toBe('rev_2');
    expect(result.changed).toBe(1);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    const textPair = result.pairs.find((pair) => pair.contentType === 'text/markdown');
    expect(textPair?.status).toBe('changed');
    expect(textPair?.diff?.added).toBe(1);
    const binaryPair = result.pairs.find(
      (pair) => pair.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(binaryPair?.status).toBe('binary-same');
    const metadata = result.pairs.find((pair) => pair.contentType === 'application/json');
    expect(metadata?.status).toBe('added');
  });
});
