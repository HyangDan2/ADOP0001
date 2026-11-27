import { describe, expect, it } from 'vitest';
import {
  BUILTIN_STRUCTURAL_VALIDATOR_IDS,
  checkDelimiters,
  checkDocx,
  checkHtml,
  checkJson,
  checkMarkdown,
  checkMermaid,
  checkPlainText,
  checkSvg,
  createValidatorRegistry,
  executeValidation,
  registerStructuralValidators,
  resolveValidationPlan,
} from '../../../src/engine/artifacts/validation';
import { POLICY, sourceDescriptor, sourceRevision } from './fixtures';

function base64(bytes: Uint8Array): string {
  return globalThis.btoa(String.fromCharCode(...bytes));
}

describe('structural validators', () => {
  it('accepts well-formed format samples', () => {
    expect(checkMarkdown('# Title\n\n- item\n\n| a | b |\n| --- | --- |\n| 1 | 2 |').problems).toEqual([]);
    expect(checkHtml('<div><p>ok</p><br></div>').problems).toEqual([]);
    expect(checkSvg('<svg xmlns="http://www.w3.org/2000/svg"><g><rect /></g></svg>').problems).toEqual([]);
    expect(checkJson('{"title":"spec"}').problems).toEqual([]);
    expect(checkJson('[1,2]').problems).toEqual([]);
    expect(checkMermaid('flowchart TD\n  A[Start] --> B[End]').problems).toEqual([]);
    expect(checkPlainText('function add() {}').problems).toEqual([]);
  });

  it('rejects malformed format samples instead of passing them', () => {
    expect(checkMarkdown('```ts\nconst x = 1').problems.length).toBeGreaterThan(0);
    expect(checkMarkdown('no heading').problems.length).toBeGreaterThan(0);
    expect(checkMarkdown('# Title\n\n[broken](link').problems.length).toBeGreaterThan(0);
    expect(checkHtml('<div><p>ok</span></div>').problems.length).toBeGreaterThan(0);
    expect(checkSvg('<svg><g></svg>').problems.length).toBeGreaterThan(0);
    expect(checkSvg('<html></html>').problems.length).toBeGreaterThan(0);
    expect(checkJson('{').problems.length).toBeGreaterThan(0);
    expect(checkJson('"text"').problems.length).toBeGreaterThan(0);
    expect(checkMermaid('A --> B').problems.length).toBeGreaterThan(0);
    expect(checkMermaid('flowchart TD\n  A[Start --> B').problems.length).toBeGreaterThan(0);
    expect(checkPlainText('   \n').problems.length).toBeGreaterThan(0);
  });

  it('checks code delimiters without parsing or compiling', () => {
    expect(checkDelimiters('function add(a: number) { return [a]; }', { hashComments: false, tripleQuotes: false })).toEqual([]);
    expect(checkDelimiters('function add(a: number) {', { hashComments: false, tripleQuotes: false }).length).toBeGreaterThan(0);
    expect(checkDelimiters('def f():\n    return (1, 2)\n', { hashComments: true, tripleQuotes: true })).toEqual([]);
    expect(checkDelimiters('const url = "https://example.test";', { hashComments: false, tripleQuotes: false })).toEqual([]);
  });

  it('requires the DOCX ZIP container and word/document.xml', () => {
    const marker = new TextEncoder().encode('word/document.xml');
    const valid = new Uint8Array(4 + marker.length);
    valid.set([0x50, 0x4b, 0x03, 0x04], 0);
    valid.set(marker, 4);
    expect(checkDocx(base64(valid), 'base64').problems).toEqual([]);
    expect(checkDocx(base64(marker), 'base64').problems.length).toBeGreaterThan(0);
    expect(checkDocx(base64(valid), 'utf8').problems.length).toBeGreaterThan(0);
  });

  it('registers real identities and leaves unregistered syntax validators UNSUPPORTED', async () => {
    const registry = createValidatorRegistry();
    const registered = await registerStructuralValidators(registry);
    expect(registered).toEqual(BUILTIN_STRUCTURAL_VALIDATOR_IDS);
    expect(registered).toContain('format.svg');
    expect(registry.get('format.markdown')?.descriptor.configHash).toMatch(/^[0-9a-f]{64}$/);

    const revision = sourceRevision();
    const plan = await resolveValidationPlan({
      descriptor: sourceDescriptor(),
      revision,
      registry,
      policy: POLICY,
    });
    const record = await executeValidation({
      artifactId: revision.artifactId,
      recordId: 'val_syntax',
      revision,
      plan,
      registry,
    });

    expect(record.results.find((result) => result.validatorId === 'c.syntax')).toMatchObject({
      executionStatus: 'UNSUPPORTED',
      requirement: 'REQUIRED',
    });
    expect(record.results.every((result) => result.executionStatus !== 'PASS')).toBe(true);
    expect(record.status).toBe('blocked');
  });
});
