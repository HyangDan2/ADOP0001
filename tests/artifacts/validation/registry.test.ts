import { describe, expect, it } from 'vitest';
import { createValidatorRegistry } from '../../../src/engine/artifacts/validation';
import {
  CONTENT_C_HEADER,
  CONTENT_C_IMPL,
  CONTENT_MD,
  CONTEXT,
  sourceDescriptor,
  sourceRevision,
  specificationDescriptor,
  specificationRevision,
  validator,
} from './fixtures';

function registryOf(...descriptors: ReturnType<typeof validator>[]) {
  const registry = createValidatorRegistry();
  for (const descriptor of descriptors) registry.register({ descriptor });
  return registry;
}

describe('WO-D03 validator registry selection', () => {
  it('selects the descriptor requirements and targets only matching entries', () => {
    const registry = registryOf(
      validator({ validatorId: 'md.structure' }),
      validator({ validatorId: 'spec.semantic', levels: ['semantic'], scopes: ['revision'] }),
    );

    const selection = registry.select({
      descriptor: specificationDescriptor(),
      revision: specificationRevision(),
      enabledLevels: ['structure', 'semantic'],
      context: CONTEXT,
    });

    expect(selection.assignments.map((assignment) => assignment.requirementSpec.validatorId)).toEqual([
      'md.structure',
      'spec.semantic',
    ]);
    expect(selection.assignments[0]).toMatchObject({
      gate: 'match',
      scope: 'content-entry',
      contentId: CONTENT_MD,
    });
    expect(selection.assignments[1]).toMatchObject({ gate: 'match', scope: 'revision' });
    expect(selection.assignments[1].contentId).toBeUndefined();
  });

  it('expands one content-entry validator over every matching entry', () => {
    const registry = registryOf(
      validator({
        validatorId: 'c.syntax',
        artifactTypes: ['source-code'],
        levels: ['syntax'],
        contentTypeMatchers: ['text/x-c'],
      }),
    );

    const selection = registry.select({
      descriptor: sourceDescriptor(),
      revision: sourceRevision(),
      enabledLevels: ['syntax'],
    });

    expect(selection.assignments).toHaveLength(2);
    expect(selection.assignments.map((assignment) => assignment.contentId).sort()).toEqual(
      [CONTENT_C_HEADER, CONTENT_C_IMPL].sort(),
    );
    expect(selection.assignments.every((assignment) => assignment.gate === 'match')).toBe(true);
  });

  it('returns payload-skip for a role mismatch instead of claiming the validator ran', () => {
    const registry = registryOf(validator({ validatorId: 'md.structure', roles: ['rendered'] }));

    const selection = registry.select({
      descriptor: specificationDescriptor({
        validationRequirements: [
          { level: 'structure', scope: 'content-entry', validatorId: 'md.structure', requirement: 'REQUIRED' },
        ],
      }),
      revision: specificationRevision(),
      enabledLevels: ['structure'],
    });

    expect(selection.assignments).toHaveLength(1);
    expect(selection.assignments[0]).toMatchObject({ gate: 'payload-skip', contentId: CONTENT_MD });
  });

  it('applies language and framework gates from the selection context', () => {
    const registry = registryOf(validator({ validatorId: 'md.structure', languages: ['python'] }));
    const descriptor = specificationDescriptor({
      validationRequirements: [
        { level: 'structure', scope: 'content-entry', validatorId: 'md.structure', requirement: 'REQUIRED' },
      ],
    });

    const mismatch = registry.select({
      descriptor,
      revision: specificationRevision(),
      enabledLevels: ['structure'],
      context: { language: 'typescript' },
    });
    expect(mismatch.assignments[0].gate).toBe('payload-skip');

    const match = registry.select({
      descriptor,
      revision: specificationRevision(),
      enabledLevels: ['structure'],
      context: { language: 'python' },
    });
    expect(match.assignments[0].gate).toBe('match');
  });

  it('surfaces an unregistered required validator as unsupported', () => {
    const registry = registryOf(validator({ validatorId: 'md.structure' }));
    const descriptor = specificationDescriptor({
      validationRequirements: [
        { level: 'structure', scope: 'content-entry', validatorId: 'md.structure', requirement: 'REQUIRED' },
        { level: 'semantic', scope: 'revision', validatorId: 'missing.validator', requirement: 'REQUIRED' },
      ],
    });

    const selection = registry.select({
      descriptor,
      revision: specificationRevision(),
      enabledLevels: ['structure', 'semantic'],
    });

    const missing = selection.assignments.find(
      (assignment) => assignment.requirementSpec.validatorId === 'missing.validator',
    );
    expect(missing).toMatchObject({ gate: 'unsupported', descriptor: null });
    expect(selection.unsupportedRequired.map((spec) => spec.validatorId)).toEqual(['missing.validator']);
  });

  it('does not select requirements whose level is disabled or unsupported by the descriptor', () => {
    const registry = registryOf(
      validator({ validatorId: 'md.structure' }),
      validator({ validatorId: 'spec.semantic', levels: ['semantic'], scopes: ['revision'] }),
    );

    const selection = registry.select({
      descriptor: specificationDescriptor(),
      revision: specificationRevision(),
      enabledLevels: ['structure', 'compile'],
    });

    expect(selection.enabledLevels).toEqual(['structure']);
    expect(selection.assignments.map((assignment) => assignment.requirementSpec.validatorId)).toEqual([
      'md.structure',
    ]);
  });

  it('rejects duplicate ids, malformed configuration hashes, and empty capabilities', () => {
    const registry = createValidatorRegistry();
    registry.register({ descriptor: validator({ validatorId: 'md.structure' }) });
    expect(() => registry.register({ descriptor: validator({ validatorId: 'md.structure' }) })).toThrow(
      /already registered/,
    );
    expect(() =>
      registry.register({ descriptor: validator({ validatorId: 'bad.hash', configHash: 'ABC' }) }),
    ).toThrow(/64 lowercase hex/);
    expect(() =>
      registry.register({ descriptor: validator({ validatorId: 'no.types', artifactTypes: [] }) }),
    ).toThrow(/artifactTypes is empty/);
  });

  it('takes the artifact type from the descriptor because revisions do not carry one', () => {
    const registry = registryOf(validator({ validatorId: 'md.structure' }));
    const selection = registry.select({
      descriptor: specificationDescriptor(),
      revision: specificationRevision(),
      enabledLevels: ['structure'],
    });
    expect(selection.artifactType).toBe('specification');
    expect(selection.assignments).toHaveLength(1);
  });

  it('keeps the registry keyed by capabilities, not tool names', () => {
    const registry = registryOf(
      validator({
        validatorId: 'c.syntax',
        artifactTypes: ['source-code'],
        levels: ['syntax'],
        contentTypeMatchers: ['text/x-c'],
      }),
    );

    expect(registry.get('c.syntax')?.descriptor.artifactTypes).toEqual(['source-code']);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('shiori')).toBeUndefined();
    expect(
      registry.select({
        descriptor: sourceDescriptor(),
        revision: sourceRevision(),
        enabledLevels: ['syntax'],
      }).assignments,
    ).toHaveLength(2);
  });
});
