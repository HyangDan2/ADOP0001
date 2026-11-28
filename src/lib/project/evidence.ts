import type { ProjectIndex } from '../../engine/project/types';
import type { ProjectContextSelection } from '../../engine/project/context';
import type { ToolId } from '../../adapters/types';
import { canonicalJson } from '../../engine/hybrid/canonical';
import { sha256Hex } from '../util';

/**
 * WO-F04 — digest evidence for a project bundle.
 *
 * The evidence binds the tool, the selected files, the snapshot and the bundle
 * text with SHA-256 digests so a downloaded bundle can be traced back to the
 * index revision it was produced from. It stores no timestamps, so identical
 * inputs produce identical evidence and can be re-verified at any time.
 */

export const PROJECT_EVIDENCE_VERSION = 'adop0001.project-evidence.v1';

export interface ProjectBundleFileRecord {
  path: string;
  language: string;
  sha256: string;
  tokens: number;
  truncated: boolean;
  reason: string;
}

export interface ProjectBundleEvidence {
  version: typeof PROJECT_EVIDENCE_VERSION;
  toolId: ToolId;
  selectionDigest: string;
  snapshotDigest: string;
  bundleDigest: string;
  files: ProjectBundleFileRecord[];
  stats: { files: number; tokens: number; budget: number; excluded: number; truncated: boolean };
}

export interface EvidenceInput {
  index: ProjectIndex;
  selection: ProjectContextSelection;
  toolId: ToolId;
  snapshotText: string;
  bundleText: string;
}

function selectionPayload(selection: ProjectContextSelection): unknown {
  return {
    budget: selection.budget,
    tokens: selection.tokens,
    truncated: selection.truncated,
    files: selection.files.map((file) => ({
      path: file.path,
      language: file.language,
      sha256: file.sha256,
      tokens: file.tokens,
      truncated: file.truncated,
      reason: file.reason,
    })),
    excluded: selection.excluded.map((entry) => ({ path: entry.path, reason: entry.reason })),
  };
}

export async function createProjectBundleEvidence(input: EvidenceInput): Promise<ProjectBundleEvidence> {
  const { selection } = input;
  return {
    version: PROJECT_EVIDENCE_VERSION,
    toolId: input.toolId,
    selectionDigest: await sha256Hex(canonicalJson(selectionPayload(selection))),
    snapshotDigest: await sha256Hex(input.snapshotText),
    bundleDigest: await sha256Hex(input.bundleText),
    files: selection.files.map((file) => ({
      path: file.path,
      language: file.language,
      sha256: file.sha256,
      tokens: file.tokens,
      truncated: file.truncated,
      reason: file.reason,
    })),
    stats: {
      files: selection.files.length,
      tokens: selection.tokens,
      budget: selection.budget,
      excluded: selection.excluded.length,
      truncated: selection.truncated,
    },
  };
}

export interface EvidenceVerification {
  ok: boolean;
  errors: string[];
}

export async function verifyProjectEvidence(input: {
  index: ProjectIndex;
  selection: ProjectContextSelection;
  snapshotText: string;
  bundleText: string;
  evidence: ProjectBundleEvidence;
}): Promise<EvidenceVerification> {
  const errors: string[] = [];
  const { index, selection, evidence } = input;

  if (evidence.version !== PROJECT_EVIDENCE_VERSION) {
    errors.push(`未知の証跡バージョンです: ${String(evidence.version)}`);
  }

  const expectedSelectionDigest = await sha256Hex(canonicalJson(selectionPayload(selection)));
  if (evidence.selectionDigest !== expectedSelectionDigest) {
    errors.push('選択コンテキストのダイジェストが一致しません。');
  }
  const expectedSnapshotDigest = await sha256Hex(input.snapshotText);
  if (evidence.snapshotDigest !== expectedSnapshotDigest) {
    errors.push('スナップショットのダイジェストが一致しません。');
  }
  const expectedBundleDigest = await sha256Hex(input.bundleText);
  if (evidence.bundleDigest !== expectedBundleDigest) {
    errors.push('バンドルのダイジェストが一致しません。');
  }

  if (evidence.files.length !== selection.files.length) {
    errors.push('証跡のファイル数が選択コンテキストと一致しません。');
  }

  const indexFiles = new Map(index.files.map((file) => [file.path, file]));
  for (const record of evidence.files) {
    const indexed = indexFiles.get(record.path);
    if (!indexed) {
      errors.push(`証跡のファイルがインデックスにありません: ${record.path}`);
      continue;
    }
    if (indexed.sha256 !== record.sha256) {
      errors.push(`インデックスのハッシュが証跡と一致しません: ${record.path}`);
    }
    const selected = selection.files.find((file) => file.path === record.path);
    if (!selected) {
      errors.push(`証跡のファイルが選択コンテキストにありません: ${record.path}`);
      continue;
    }
    if (selected.sha256 !== record.sha256) {
      errors.push(`選択時のハッシュが証跡と一致しません: ${record.path}`);
    }
    if (!input.bundleText.includes(record.path)) {
      errors.push(`バンドルにファイルの痕跡がありません: ${record.path}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
