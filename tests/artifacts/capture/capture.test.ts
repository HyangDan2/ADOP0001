/**
 * CP03 capture layer: create on first success, append on fingerprint change,
 * no-op on identical input, and never register a superseded request.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../src/engine/core/contracts';
import type { ArtifactContentInput } from '../../../src/engine/artifacts/types';
import { createValidatorRegistry, type ValidatorRegistry } from '../../../src/engine/artifacts/validation/registry';
import { registerStructuralValidators } from '../../../src/engine/artifacts/validation/formats';
import {
  createArtifactCaptureService,
  type ArtifactCaptureRequest,
} from '../../../src/lib/artifacts/capture';
import { repositoryFixture, SLOT } from '../repository/helpers';

const SOURCE_HASH = 'a'.repeat(64);
const CACHE_KEY = 'c'.repeat(64);

function context(overrides: Partial<ExecutionContext<'shiori'>> = {}): ExecutionContext<'shiori'> {
  return {
    requestId: 'shiori-1',
    toolId: 'shiori',
    sourceName: 'payment-service.ts',
    sourceHash: SOURCE_HASH,
    options: { sections: ['overview', 'contracts'], includePrivate: true },
    providerMode: 'local-static',
    diagnostics: [],
    elapsedMs: 12,
    cacheKey: CACHE_KEY,
    engineVersion: '5b.2',
    cacheHit: false,
    ...overrides,
  };
}

const CONTENTS: ArtifactContentInput[] = [
  { role: 'primary', contentType: 'text/markdown', encoding: 'utf8', payload: '# Specification\n\nBody.\n' },
  { role: 'rendered', contentType: 'text/html', encoding: 'utf8', payload: '<html><body><p>x</p></body></html>' },
];

let recordCounter = 0;

function fixture() {
  const handle = repositoryFixture();
  const registry = createValidatorRegistry();
  const ready = registerStructuralValidators(registry).then(() => registry as ValidatorRegistry);
  const service = createArtifactCaptureService({
    repository: handle.repo,
    registry: ready,
    now: () => new Date('2026-11-27T10:00:00.000Z'),
    recordId: () => `val_${(recordCounter += 1)}`,
  });
  return { ...handle, service };
}

function request(
  overrides: Partial<ArtifactCaptureRequest<'shiori'>> = {},
): ArtifactCaptureRequest<'shiori'> {
  return {
    slot: SLOT,
    context: context(),
    contents: CONTENTS,
    inputRevision: 1,
    isCurrent: () => true,
    ...overrides,
  };
}

describe('capture layer', () => {
  it('creates the artifact, appends the first revision, and commits validation', async () => {
    const { repo, service } = fixture();
    const result = await service.capture(request());

    expect(result.status).toBe('created');
    expect(result.revision?.ordinal).toBe(1);
    expect(result.revision?.sourceRevision.inputFingerprint).toBe(result.fingerprint);
    expect(result.revision?.sourceRevision.sourceHash).toBe(SOURCE_HASH);
    expect(result.validation?.status).toBe('valid');
    expect(await repo.listRevisions({ artifactId: result.artifact!.artifactId })).toHaveLength(1);
    expect(
      await repo.listValidations({ artifactId: result.artifact!.artifactId }),
    ).toHaveLength(1);
    expect((await repo.getArtifact(result.artifact!.artifactId))?.validationSummary).toBe('valid');
  });

  it('is a no-op when the fingerprint is unchanged', async () => {
    const { repo, service } = fixture();
    const first = await service.capture(request());
    const second = await service.capture(request());

    expect(second.status).toBe('unchanged');
    expect(second.revision?.revisionId).toBe(first.revision?.revisionId);
    expect(second.validation?.status).toBe('valid');
    expect(await repo.listRevisions({ artifactId: first.artifact!.artifactId })).toHaveLength(1);
    expect(await repo.listValidations({ artifactId: first.artifact!.artifactId })).toHaveLength(1);
  });

  it('appends a second revision when options change but the source does not', async () => {
    const { repo, service } = fixture();
    const first = await service.capture(request());
    const second = await service.capture(
      request({
        context: context({ options: { sections: ['contracts'], includePrivate: true } }),
      }),
    );

    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.status).toBe('appended');
    expect(second.revision?.ordinal).toBe(2);
    expect(second.revision?.parentRevisionId).toBe(first.revision?.revisionId);
    expect(second.validation?.status).toBe('valid');
    expect(await repo.listRevisions({ artifactId: first.artifact!.artifactId })).toHaveLength(2);
  });

  it('treats a binary digest as fingerprint material', async () => {
    const { service } = fixture();
    const first = await service.capture(
      request({ binaryInputs: { 'template.docx': 'd'.repeat(64) } }),
    );
    const same = await service.capture(
      request({ binaryInputs: { 'template.docx': 'd'.repeat(64) } }),
    );
    const changed = await service.capture(
      request({ binaryInputs: { 'template.docx': 'e'.repeat(64) } }),
    );

    expect(same.status).toBe('unchanged');
    expect(changed.status).toBe('appended');
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it('never creates an artifact for a superseded request', async () => {
    const { repo, service } = fixture();
    const result = await service.capture(request({ isCurrent: () => false }));

    expect(result.status).toBe('superseded');
    expect(result.artifact).toBeNull();
    expect(await repo.listArtifacts()).toHaveLength(0);
  });

  it('keeps the appended revision but skips validation when superseded mid-capture', async () => {
    const { repo, service } = fixture();
    let calls = 0;
    const result = await service.capture(
      request({
        isCurrent: () => {
          calls += 1;
          return calls <= 1;
        },
      }),
    );

    expect(result.status).toBe('superseded');
    const revisions = await repo.listRevisions({ artifactId: result.artifact!.artifactId });
    expect(revisions).toHaveLength(1);
    expect(await repo.listValidations({ artifactId: result.artifact!.artifactId })).toHaveLength(0);
  });

  it('records an invalid validation instead of dropping the revision', async () => {
    const { repo, service } = fixture();
    const result = await service.capture(
      request({
        contents: [{ role: 'primary', contentType: 'text/markdown', encoding: 'utf8', payload: 'Body without heading.\n' }],
      }),
    );

    expect(result.status).toBe('created');
    expect(result.validation?.status).not.toBe('valid');
    expect((await repo.getArtifact(result.artifact!.artifactId))?.validationSummary).not.toBe('valid');
    expect(await repo.listRevisions({ artifactId: result.artifact!.artifactId })).toHaveLength(1);
  });
});
