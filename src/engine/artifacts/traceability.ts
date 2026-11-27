/**
 * WO-D05 — artifact traceability and requirement mapping.
 *
 * Every captured artifact is joined back to the product requirement it
 * evidences: the requirement catalogue names the tool/type, and the report
 * resolves the newest stored revision, its validation record and its normal
 * exports. The report is derived, never stored, so it cannot drift from the
 * repository and it reuses the same hashes the guard writes.
 */

import type { ToolId } from '../../adapters/types';
import type {
  ArtifactRecord,
  ArtifactRevision,
  ArtifactType,
  ExportRecord,
  ValidationRecord,
} from './types';

export const TRACEABILITY_VERSION = 'adop0001.traceability.v1';

export type RequirementStatus = 'missing' | 'captured' | 'validated' | 'exported';

export interface RequirementDefinition {
  id: string;
  titleJa: string;
  toolId: ToolId;
  artifactTypes: readonly ArtifactType[];
  /** Normal export formats that evidence this requirement; any when omitted. */
  evidenceFormats?: readonly string[];
  /** The requirement is about the export itself, so validation alone cannot evidence it. */
  exportOnly?: boolean;
  /** Where the requirement is registered. */
  source: 'SUP-D01' | 'SUP-D03' | 'SUP-D06' | 'WO-D05' | 'WO-D06' | 'WO-D07';
}

export const REQUIREMENT_CATALOGUE: readonly RequirementDefinition[] = [
  {
    id: 'REQ-SH-01',
    titleJa: '仕様書成果物（Markdown / HTML）',
    toolId: 'shiori',
    artifactTypes: ['specification'],
    evidenceFormats: ['markdown', 'html', 'package'],
    source: 'SUP-D06',
  },
  {
    id: 'REQ-YA-01',
    titleJa: '疑似コード成果物（Markdown / テキスト）',
    toolId: 'yayoi',
    artifactTypes: ['pseudocode'],
    evidenceFormats: ['markdown', 'text', 'package'],
    source: 'SUP-D06',
  },
  {
    id: 'REQ-KZ-01',
    titleJa: 'UML 図成果物（Mermaid / SVG / PNG）',
    toolId: 'kozue',
    artifactTypes: ['uml-diagram'],
    evidenceFormats: ['mmd', 'svg', 'png', 'package'],
    source: 'SUP-D06',
  },
  {
    id: 'REQ-HR-01',
    titleJa: 'テストスイート成果物',
    toolId: 'haruhi',
    artifactTypes: ['test-suite'],
    evidenceFormats: ['test', 'package'],
    source: 'SUP-D06',
  },
  {
    id: 'REQ-KT-01',
    titleJa: 'Markdown 文書成果物',
    toolId: 'kotoha',
    artifactTypes: ['markdown-document'],
    evidenceFormats: ['markdown', 'bundle', 'package'],
    source: 'SUP-D06',
  },
  {
    id: 'REQ-KT-02',
    titleJa: 'DOCX 文書成果物',
    toolId: 'kotoha',
    artifactTypes: ['docx-document'],
    evidenceFormats: ['docx', 'markdown', 'bundle', 'package'],
    source: 'SUP-D06',
  },
  {
    id: 'REQ-TK-01',
    titleJa: 'ソースコード成果物',
    toolId: 'takane',
    artifactTypes: ['source-code'],
    evidenceFormats: ['python', 'c', 'c-header', 'cpp', 'cpp-header', 'mcu', 'mcu-header', 'all', 'package'],
    source: 'SUP-D06',
  },
  {
    id: 'REQ-G2-01',
    titleJa: '系譜の追跡（入力 → リビジョン）',
    toolId: 'shiori',
    artifactTypes: [
      'specification',
      'pseudocode',
      'uml-diagram',
      'test-suite',
      'markdown-document',
      'docx-document',
      'source-code',
    ],
    source: 'WO-D05',
  },
  {
    id: 'REQ-G2-02',
    titleJa: '検証記録の追跡（リビジョン → 検証）',
    toolId: 'shiori',
    artifactTypes: [
      'specification',
      'pseudocode',
      'uml-diagram',
      'test-suite',
      'markdown-document',
      'docx-document',
      'source-code',
    ],
    source: 'WO-D05',
  },
  {
    id: 'REQ-G2-03',
    titleJa: '書き出し履歴の追跡（リビジョン → エクスポート）',
    toolId: 'shiori',
    artifactTypes: [
      'specification',
      'pseudocode',
      'uml-diagram',
      'test-suite',
      'markdown-document',
      'docx-document',
      'source-code',
    ],
    evidenceFormats: ['package'],
    exportOnly: true,
    source: 'WO-D05',
  },
  {
    id: 'REQ-G2-04',
    titleJa: 'パッケージ整合性（マニフェスト + SHA-256）',
    toolId: 'shiori',
    artifactTypes: [
      'specification',
      'pseudocode',
      'uml-diagram',
      'test-suite',
      'markdown-document',
      'docx-document',
      'source-code',
    ],
    evidenceFormats: ['package'],
    exportOnly: true,
    source: 'WO-D06',
  },
];

export interface TraceabilityExportEvidence {
  exportId: string;
  format: string;
  kind: ExportRecord['kind'];
  exportByteHash: string;
  exportByteLength: number;
  createdAt: string;
}

export interface TraceabilityArtifactEvidence {
  artifactId: string;
  toolId: ToolId;
  artifactType: ArtifactType;
  currentRevisionId: string | null;
  ordinal: number | null;
  revisionHash: string | null;
  contentDigest: string | null;
  revisionCount: number;
  sourceName: string | null;
  inputFingerprint: string | null;
  validationStatus: ValidationRecord['status'] | null;
  validationRecordId: string | null;
  effectiveValidation: boolean;
  dependencyCount: number;
  exports: TraceabilityExportEvidence[];
  status: RequirementStatus;
}

export interface RequirementTrace {
  requirement: RequirementDefinition;
  status: RequirementStatus;
  evidence: TraceabilityArtifactEvidence[];
}

export interface TraceabilitySummary {
  total: number;
  missing: number;
  captured: number;
  validated: number;
  exported: number;
}

export interface TraceabilityReport {
  version: typeof TRACEABILITY_VERSION;
  requirements: RequirementTrace[];
  summary: TraceabilitySummary;
}

export interface TraceabilityInput {
  artifacts: readonly ArtifactRecord[];
  revisions: readonly ArtifactRevision[];
  validations: readonly ValidationRecord[];
  exports: readonly ExportRecord[];
  requirements?: readonly RequirementDefinition[];
}

const STATUS_RANK: Record<RequirementStatus, number> = {
  missing: 0,
  captured: 1,
  validated: 2,
  exported: 3,
};

function isEffectiveValidation(record: ValidationRecord, revision: ArtifactRevision): boolean {
  return (
    (record.status === 'valid' || record.status === 'warning') &&
    record.validatedRevisionId === revision.revisionId &&
    record.validatedContentDigest === revision.contentDigest &&
    record.validatedRevisionHash === revision.revisionHash
  );
}

function newestValidation(
  validations: readonly ValidationRecord[],
  artifactId: string,
  revisionId: string,
): ValidationRecord | null {
  const matching = validations
    .filter(
      (record) => record.artifactId === artifactId && record.validatedRevisionId === revisionId,
    )
    .sort((a, b) => {
      if (a.validatedAt !== b.validatedAt) return a.validatedAt < b.validatedAt ? 1 : -1;
      return a.recordId < b.recordId ? 1 : a.recordId > b.recordId ? -1 : 0;
    });
  return matching[0] ?? null;
}

function requirementAcceptsExport(
  requirement: RequirementDefinition,
  record: ExportRecord,
): boolean {
  if (record.kind !== 'normal') return false;
  if (!requirement.evidenceFormats) return true;
  return requirement.evidenceFormats.includes(record.format);
}

function evidenceFor(
  artifact: ArtifactRecord,
  revision: ArtifactRevision | null,
  validations: readonly ValidationRecord[],
  exports: readonly ExportRecord[],
  requirement: RequirementDefinition,
): TraceabilityArtifactEvidence {
  const artifactExports = revision
    ? exports.filter(
        (record) =>
          record.artifactId === artifact.artifactId && record.revisionId === revision.revisionId,
      )
    : [];
  const record = revision ? newestValidation(validations, artifact.artifactId, revision.revisionId) : null;
  const effective = Boolean(record && revision && isEffectiveValidation(record, revision));
  const hasNormalEvidence = artifactExports.some((item) =>
    requirementAcceptsExport(requirement, item),
  );
  const status: RequirementStatus = !revision
    ? 'captured'
    : hasNormalEvidence
      ? 'exported'
      : effective && !requirement.exportOnly
        ? 'validated'
        : 'captured';
  return {
    artifactId: artifact.artifactId,
    toolId: artifact.toolId,
    artifactType: artifact.artifactType,
    currentRevisionId: revision?.revisionId ?? null,
    ordinal: revision?.ordinal ?? null,
    revisionHash: revision?.revisionHash ?? null,
    contentDigest: revision?.contentDigest ?? null,
    revisionCount: artifact.revisionCount,
    sourceName: revision?.sourceRevision.sourceName ?? null,
    inputFingerprint: revision?.sourceRevision.inputFingerprint ?? null,
    validationStatus: record?.status ?? null,
    validationRecordId: record?.recordId ?? null,
    effectiveValidation: effective,
    dependencyCount: revision?.dependencies.length ?? 0,
    exports: artifactExports.map((record) => ({
      exportId: record.exportId,
      format: record.format,
      kind: record.kind,
      exportByteHash: record.exportByteHash,
      exportByteLength: record.exportByteLength,
      createdAt: record.createdAt,
    })),
    status,
  };
}

export function buildTraceabilityReport(input: TraceabilityInput): TraceabilityReport {
  const requirements = input.requirements ?? REQUIREMENT_CATALOGUE;
  const currentByArtifact = new Map<string, ArtifactRevision>();
  for (const revision of input.revisions) {
    const existing = currentByArtifact.get(revision.artifactId);
    if (!existing || revision.ordinal > existing.ordinal) {
      currentByArtifact.set(revision.artifactId, revision);
    }
  }

  const traces: RequirementTrace[] = requirements.map((requirement) => {
    const matching = input.artifacts
      .filter((artifact) => requirement.artifactTypes.includes(artifact.artifactType))
      .filter(
        (artifact) =>
          requirement.id.startsWith('REQ-G2-') || artifact.toolId === requirement.toolId,
      )
      .sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0));
    const evidence = matching.map((artifact) =>
      evidenceFor(
        artifact,
        currentByArtifact.get(artifact.artifactId) ?? null,
        input.validations,
        input.exports,
        requirement,
      ),
    );
    const status = evidence.reduce<RequirementStatus>(
      (best, item) => (STATUS_RANK[item.status] > STATUS_RANK[best] ? item.status : best),
      'missing',
    );
    return { requirement, status, evidence };
  });

  const summary: TraceabilitySummary = {
    total: traces.length,
    missing: traces.filter((trace) => trace.status === 'missing').length,
    captured: traces.filter((trace) => trace.status === 'captured').length,
    validated: traces.filter((trace) => trace.status === 'validated').length,
    exported: traces.filter((trace) => trace.status === 'exported').length,
  };
  return { version: TRACEABILITY_VERSION, requirements: traces, summary };
}

export interface TraceabilityRepository {
  listArtifacts(filter?: { includeDeleted?: boolean }): Promise<ArtifactRecord[]>;
  getCurrentRevision(artifactId: string): Promise<ArtifactRevision | null>;
  listValidations(input: { artifactId: string; limit?: number }): Promise<ValidationRecord[]>;
  listExports(input: { artifactId: string; limit?: number }): Promise<ExportRecord[]>;
}

/** Loads the evidence a report needs for the visible (non-deleted) artifacts. */
export async function loadTraceabilityReport(
  repository: TraceabilityRepository,
): Promise<TraceabilityReport> {
  const artifacts = await repository.listArtifacts();
  const revisions: ArtifactRevision[] = [];
  const validations: ValidationRecord[] = [];
  const exports: ExportRecord[] = [];
  for (const artifact of artifacts) {
    const revision = await repository.getCurrentRevision(artifact.artifactId);
    if (revision) revisions.push(revision);
    validations.push(...(await repository.listValidations({ artifactId: artifact.artifactId })));
    exports.push(...(await repository.listExports({ artifactId: artifact.artifactId })));
  }
  return buildTraceabilityReport({ artifacts, revisions, validations, exports });
}
