/**
 * CP03 export guard: fingerprint identity, stored revision identity, payload
 * hash, registration order, and rendered derivations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../../src/engine/core/contracts';
import type { ArtifactContentInput } from '../../../src/engine/artifacts/types';
import { createValidatorRegistry } from '../../../src/engine/artifacts/validation/registry';
import { registerStructuralValidators } from '../../../src/engine/artifacts/validation/formats';
import {
  ARTIFACT_VALIDATION_POLICY,
  __resetArtifactCaptureRuntimeForTests,
  createArtifactCaptureService,
  getArtifactSlotSnapshot,
  type ArtifactCaptureRequest,
} from '../../../src/lib/artifacts/capture';
import {
  CONTENT_MISMATCH_MESSAGE,
  MOVED_ARTIFACT_MESSAGE,
  NO_ARTIFACT_MESSAGE,
  STALE_INPUT_MESSAGE,
  VALIDATION_BLOCKED_MESSAGE,
  entryByRole,
  guardCopyText,
  guardExport,
  textBytes,
  type ExportGuardBinding,
} from '../../../src/components/artifacts/ExportGuard';
import { repositoryFixture, SLOT } from '../repository/helpers';

const CONTENTS: ArtifactContentInput[] = [
  { role: 'primary', contentType: 'text/markdown', encoding: 'utf8', payload: '# Spec\n' },
];

function context(overrides: Partial<ExecutionContext<'shiori'>> = {}): ExecutionContext<'shiori'> {
  return {
    requestId: 'shiori-1',
    toolId: 'shiori',
    sourceName: 'spec.ts',
    sourceHash: 'a'.repeat(64),
    options: { sections: ['overview'], includePrivate: true },
    providerMode: 'local-static',
    diagnostics: [],
    elapsedMs: 3,
    cacheKey: 'c'.repeat(64),
    engineVersion: '5b.2',
    cacheHit: false,
    ...overrides,
  };
}

async function fixture() {
  const handle = repositoryFixture();
  const registry = createValidatorRegistry();
  await registerStructuralValidators(registry);
  const service = createArtifactCaptureService({ repository: handle.repo, registry });
  const request = (overrides: Partial<ArtifactCaptureRequest<'shiori'>> = {}) =>
    service.capture({
      slot: SLOT,
      context: context(),
      contents: CONTENTS,
      inputRevision: 1,
      isCurrent: () => true,
      ...overrides,
    });
  return { ...handle, request };
}

beforeEach(() => {
  __resetArtifactCaptureRuntimeForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function binding(
  fingerprint: string,
  assertCurrent: () => void = () => {},
): ExportGuardBinding {
  return {
    slot: SLOT,
    assertCurrent,
    liveFingerprint: async () => fingerprint,
  };
}

describe('export guard', () => {
  it('writes the file and registers the export after all checks', async () => {
    const { repo, request } = await fixture();
    const captured = await request();
    const snapshot = getArtifactSlotSnapshot(SLOT)!;
    const writes: Array<{ name: string; bytes: Uint8Array }> = [];

    const records = await guardExport(
      binding(snapshot.fingerprint),
      [
        {
          format: 'markdown',
          fileName: 'payment.spec.md',
          contentType: 'text/markdown',
          entry: entryByRole('primary'),
          payload: () => '# Spec\n',
        },
      ],
      (bytes, name) => {
        writes.push({ name, bytes });
      },
      { repository: repo, snapshot },
    );

    expect(writes).toHaveLength(1);
    expect(writes[0].name).toBe('payment.spec.md');
    expect(new TextDecoder().decode(writes[0].bytes)).toBe('# Spec\n');
    expect(records[0].kind).toBe('normal');
    expect(records[0].derivation.kind).toBe('direct');
    expect(records[0].exportContentType).toBe('text/markdown');
    const exports = await repo.listExports({ artifactId: captured.artifact!.artifactId });
    expect(exports).toHaveLength(1);
  });

  it('refuses when the legacy pane revision check throws', async () => {
    const { repo, request } = await fixture();
    await request();
    const snapshot = getArtifactSlotSnapshot(SLOT)!;
    const write = vi.fn();

    await expect(
      guardExport(
        binding(snapshot.fingerprint, () => {
          throw new Error(STALE_INPUT_MESSAGE);
        }),
        [
          {
            format: 'markdown',
            fileName: 'x.md',
            contentType: 'text/markdown',
            entry: entryByRole('primary'),
            payload: () => '# Spec\n',
          },
        ],
        write,
        { repository: repo, snapshot },
      ),
    ).rejects.toThrow(STALE_INPUT_MESSAGE);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses when the live fingerprint drifted', async () => {
    const { repo, request } = await fixture();
    await request();
    const snapshot = getArtifactSlotSnapshot(SLOT)!;
    const write = vi.fn();

    await expect(
      guardExport(
        binding('f'.repeat(64)),
        [
          {
            format: 'markdown',
            fileName: 'x.md',
            contentType: 'text/markdown',
            entry: entryByRole('primary'),
            payload: () => '# Spec\n',
          },
        ],
        write,
        { repository: repo, snapshot },
      ),
    ).rejects.toThrow(STALE_INPUT_MESSAGE);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses when the payload does not match the stored content hash', async () => {
    const { repo, request } = await fixture();
    await request();
    const snapshot = getArtifactSlotSnapshot(SLOT)!;
    const write = vi.fn();

    await expect(
      guardExport(
        binding(snapshot.fingerprint),
        [
          {
            format: 'markdown',
            fileName: 'x.md',
            contentType: 'text/markdown',
            entry: entryByRole('primary'),
            payload: () => '# Different\n',
          },
        ],
        write,
        { repository: repo, snapshot },
      ),
    ).rejects.toThrow(CONTENT_MISMATCH_MESSAGE);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses when the stored revision moved after the snapshot', async () => {
    const { repo, request } = await fixture();
    const first = await request();
    const snapshot = getArtifactSlotSnapshot(SLOT)!;
    const second = await request({
      context: context({ options: { sections: ['overview', 'types'], includePrivate: true } }),
      inputRevision: 2,
    });
    expect(second.revision!.revisionId).not.toBe(first.revision!.revisionId);
    const write = vi.fn();

    await expect(
      guardExport(
        binding(snapshot.fingerprint),
        [
          {
            format: 'markdown',
            fileName: 'x.md',
            contentType: 'text/markdown',
            entry: entryByRole('primary'),
            payload: () => '# Spec\n',
          },
        ],
        write,
        { repository: repo, snapshot },
      ),
    ).rejects.toThrow(MOVED_ARTIFACT_MESSAGE);
    expect(write).not.toHaveBeenCalled();
  });

  it('registers a rendered derivation without comparing the rendered byte hash', async () => {
    const { repo, request } = await fixture();
    await request();
    const snapshot = getArtifactSlotSnapshot(SLOT)!;

    const records = await guardExport(
      binding(snapshot.fingerprint),
      [
        {
          format: 'html',
          fileName: 'payment.spec.html',
          contentType: 'text/html',
          entry: entryByRole('primary'),
          payload: () => '<html><body>rendered</body></html>',
          derivation: 'rendered',
        },
      ],
      () => {},
      { repository: repo, snapshot },
    );

    expect(records[0].derivation.kind).toBe('rendered');
    expect(records[0].derivation.sourceContentId).toBe(snapshot.revision.contents[0].contentId);
  });

  it('reports a missing artifact instead of writing a file', async () => {
    const { repo } = await fixture();
    const write = vi.fn();
    await expect(
      guardExport(
        binding('a'.repeat(64)),
        [
          {
            format: 'markdown',
            fileName: 'x.md',
            contentType: 'text/markdown',
            entry: entryByRole('primary'),
            payload: () => textBytes('# Spec\n'),
          },
        ],
        write,
        { repository: repo, snapshot: null, waitMs: 5 },
      ),
    ).rejects.toThrow(NO_ARTIFACT_MESSAGE);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('export guard — validation policy gating (G1-BL-14)', () => {
  const MARKDOWN_PLAN = {
    format: 'markdown',
    fileName: 'payment.spec.md',
    contentType: 'text/markdown' as const,
    entry: entryByRole('primary'),
    payload: () => '# Spec\n',
  };

  async function invalidateLatestRecord(
    repo: Awaited<ReturnType<typeof fixture>>['repo'],
    captured: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['request']>>,
  ) {
    const [record] = await repo.listValidations({
      artifactId: captured.artifact!.artifactId,
      revisionId: captured.revision!.revisionId,
    });
    await repo.commitValidation({
      artifactId: captured.artifact!.artifactId,
      revisionId: captured.revision!.revisionId,
      record: {
        ...record,
        recordId: 'val_invalid',
        validatedAt: '2099-01-01T00:00:00.000Z',
        status: 'invalid',
      },
      guard: {
        expectedScopeEpoch: 1,
        expectedHistoryEpoch: captured.artifact!.historyEpoch,
        expectedCurrentRevisionId: captured.revision!.revisionId,
      },
    });
  }

  it('blocks a download when the newest stored record is invalid', async () => {
    const { repo, request } = await fixture();
    const captured = await request();
    const snapshot = getArtifactSlotSnapshot(SLOT)!;
    await invalidateLatestRecord(repo, captured);
    const write = vi.fn();

    await expect(
      guardExport(binding(snapshot.fingerprint), [MARKDOWN_PLAN], write, {
        repository: repo,
        snapshot,
      }),
    ).rejects.toThrow(`${VALIDATION_BLOCKED_MESSAGE}（検証エラー）`);
    expect(write).not.toHaveBeenCalled();
    expect(await repo.listExports({ artifactId: captured.artifact!.artifactId })).toHaveLength(0);
  });

  it('blocks a download when the policy changed after capture', async () => {
    const { repo, request } = await fixture();
    await request();
    const snapshot = getArtifactSlotSnapshot(SLOT)!;
    const write = vi.fn();

    await expect(
      guardExport(binding(snapshot.fingerprint), [MARKDOWN_PLAN], write, {
        repository: repo,
        snapshot,
        policy: { ...ARTIFACT_VALIDATION_POLICY, policyVersion: 'adop0001.artifacts.validation.v2' },
      }),
    ).rejects.toThrow('検証ポリシー版変更');
    expect(write).not.toHaveBeenCalled();
  });

  it('blocks a download when no REQUIRED validator ran', async () => {
    const { repo } = await fixture();
    const empty = createValidatorRegistry();
    const service = createArtifactCaptureService({ repository: repo, registry: empty });
    const captured = await service.capture({
      slot: SLOT,
      context: context(),
      contents: CONTENTS,
      inputRevision: 1,
      isCurrent: () => true,
    });
    expect(captured.validation?.status).toBe('blocked');
    const snapshot = getArtifactSlotSnapshot(SLOT)!;
    const write = vi.fn();

    await expect(
      guardExport(binding(snapshot.fingerprint), [MARKDOWN_PLAN], write, {
        repository: repo,
        snapshot,
        registry: empty,
      }),
    ).rejects.toThrow(`${VALIDATION_BLOCKED_MESSAGE}（検証ブロック）`);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses to copy an invalid record and copies a valid one', async () => {
    const { repo, request } = await fixture();
    const captured = await request();
    const snapshot = getArtifactSlotSnapshot(SLOT)!;

    await expect(
      guardCopyText(binding(snapshot.fingerprint), {
        format: 'markdown',
        fileName: 'payment.spec.md',
        contentType: 'text/markdown',
        entry: entryByRole('primary'),
        text: '# Spec\n',
        repository: repo,
        snapshot,
        policy: { ...ARTIFACT_VALIDATION_POLICY, policyVersion: 'adop0001.artifacts.validation.v2' },
      }),
    ).rejects.toThrow(VALIDATION_BLOCKED_MESSAGE);

    const text = await guardCopyText(binding(snapshot.fingerprint), {
      format: 'markdown',
      fileName: 'payment.spec.md',
      contentType: 'text/markdown',
      entry: entryByRole('primary'),
      text: '# Spec\n',
      repository: repo,
      snapshot,
    });
    expect(text).toBe('# Spec\n');
    await vi.waitFor(async () => {
      const exports = await repo.listExports({ artifactId: captured.artifact!.artifactId });
      expect(exports).toHaveLength(1);
    });
  });
});
