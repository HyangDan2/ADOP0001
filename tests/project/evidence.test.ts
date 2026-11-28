import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../../src/engine/parser';
import { buildProjectIndex } from '../../src/engine/project';
import { buildProjectSnapshot, buildProjectToolBundle, PROJECT_TOOLS } from '../../src/engine/project/bundles';
import { selectProjectContext } from '../../src/engine/project/context';
import type { ProjectFile } from '../../src/engine/project/types';
import { createProjectBundleEvidence, verifyProjectEvidence, PROJECT_EVIDENCE_VERSION } from '../../src/lib/project/evidence';
import { sha256Hex } from '../../src/lib/artifacts/hash';

async function file(path: string, text: string): Promise<ProjectFile> {
  const bytes = new TextEncoder().encode(text);
  return { path, text, language: detectLanguage(path, text), byteLength: bytes.byteLength, sha256: await sha256Hex(bytes) };
}

async function sample() {
  const files = await Promise.all([
    file('src/util.ts', 'export function double(x: number): number {\n  return x * 2;\n}\n'),
    file('src/main.ts', "import { double } from './util';\nexport function run(x: number): number {\n  return double(x);\n}\n"),
  ]);
  const index = buildProjectIndex({ files });
  const selection = selectProjectContext(index, { filePath: 'src/main.ts', tokenBudget: 2000 });
  const snapshot = buildProjectSnapshot(index, selection);
  const bundleText = buildProjectToolBundle(PROJECT_TOOLS[0], index, selection);
  return { index, selection, snapshot, bundleText };
}

describe('WO-F04 project bundle evidence', () => {
  it('creates deterministic evidence that verifies against the same inputs', async () => {
    const { index, selection, snapshot, bundleText } = await sample();
    const input = { index, selection, toolId: PROJECT_TOOLS[0].toolId, snapshotText: snapshot.text, bundleText };
    const first = await createProjectBundleEvidence(input);
    const second = await createProjectBundleEvidence(input);
    expect(first).toEqual(second);
    expect(first.version).toBe(PROJECT_EVIDENCE_VERSION);
    expect(first.files.map((entry) => entry.path)).toEqual(selection.files.map((entry) => entry.path));
    for (const entry of first.files) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(bundleText).toContain(entry.path);
    }
    const result = await verifyProjectEvidence({ ...input, evidence: first });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects tampered bundle text', async () => {
    const { index, selection, snapshot, bundleText } = await sample();
    const evidence = await createProjectBundleEvidence({
      index,
      selection,
      toolId: PROJECT_TOOLS[0].toolId,
      snapshotText: snapshot.text,
      bundleText,
    });
    const result = await verifyProjectEvidence({
      index,
      selection,
      snapshotText: snapshot.text,
      bundleText: bundleText.replace('double', 'triple'),
      evidence,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('バンドル'))).toBe(true);
  });

  it('rejects an index whose file hash changed', async () => {
    const { index, selection, snapshot, bundleText } = await sample();
    const evidence = await createProjectBundleEvidence({
      index,
      selection,
      toolId: PROJECT_TOOLS[0].toolId,
      snapshotText: snapshot.text,
      bundleText,
    });
    const tampered = {
      ...index,
      files: index.files.map((entry) =>
        entry.path === 'src/util.ts' ? { ...entry, sha256: 'f'.repeat(64) } : entry,
      ),
    };
    const result = await verifyProjectEvidence({ index: tampered, selection, snapshotText: snapshot.text, bundleText, evidence });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('src/util.ts'))).toBe(true);
  });

  it('rejects a different selection that still shares the bundle text', async () => {
    const { index, selection, snapshot, bundleText } = await sample();
    const evidence = await createProjectBundleEvidence({
      index,
      selection,
      toolId: PROJECT_TOOLS[0].toolId,
      snapshotText: snapshot.text,
      bundleText,
    });
    const otherSelection = { ...selection, files: selection.files.slice(0, 1) };
    const result = await verifyProjectEvidence({
      index,
      selection: otherSelection,
      snapshotText: snapshot.text,
      bundleText,
      evidence,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
