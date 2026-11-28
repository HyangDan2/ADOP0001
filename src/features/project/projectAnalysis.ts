import type { ToolId } from '../../adapters/types';
import type { ProviderCapabilities } from '../../engine/hybrid/providerProfiles';
import { planHybridRequest, type HybridRequestPlan } from '../../engine/hybrid/requestPlan';
import type { ConnectionSettings } from '../../engine/hybrid/settings';
import { selectProjectContext, type ProjectContextSelection } from '../../engine/project/context';
import { buildProjectSnapshot, PROJECT_SNAPSHOT_VERSION, type ProjectSnapshot } from '../../engine/project/bundles';
import type { ProjectIndex } from '../../engine/project/types';

/**
 * WO-E06 — project analysis through the existing hybrid orchestrator contract.
 *
 * The project never invents a second request pipeline: the selected context is
 * serialised as one fenced snapshot and handed to `planHybridRequest`, so the
 * existing budget, redaction, boundary and approval rules apply unchanged.
 * Nothing is transmitted here; the caller must still approve the preview.
 */

export const PROJECT_CONTEXT_TOKEN_BUDGET = 8000;

export interface ProjectHybridRequestInput {
  index: ProjectIndex;
  toolId: ToolId;
  query?: string;
  filePath?: string;
  tokenBudget?: number;
  settings?: ConnectionSettings;
  providerId?: string;
  capabilities?: ProviderCapabilities;
  secrets?: string[];
}

export interface ProjectHybridResult {
  plan: HybridRequestPlan;
  snapshot: ProjectSnapshot;
  selection: ProjectContextSelection;
}

function queryTerms(query: string | undefined): string[] {
  if (!query) return [];
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_$]+/u).filter((token) => token.length >= 2))];
}

/** Deterministic fact sheet handed to the model as local analysis (bounded). */
export function projectLocalAnalysis(index: ProjectIndex, limit = 40): string {
  const lines: string[] = [
    `PROJECT FACTS (${PROJECT_SNAPSHOT_VERSION})`,
    `files: ${index.stats.fileCount}, symbols: ${index.stats.symbolCount}, references: ${index.stats.referenceCount}`,
    `resolution: resolved=${index.stats.resolved} ambiguous=${index.stats.ambiguous} unresolved=${index.stats.unresolved} external=${index.stats.external}`,
    'symbols:',
  ];
  for (const symbol of index.symbolTable.symbols.slice(0, limit)) {
    lines.push(
      `- ${symbol.filePath}:${symbol.line} ${symbol.kind} ${symbol.owner ? `${symbol.owner}.` : ''}${symbol.name}${symbol.exported ? ' [exported]' : ''}`,
    );
  }
  lines.push('dependencies:');
  for (const edge of index.graph.edges.slice(0, limit)) {
    lines.push(`- ${edge.from} -> ${edge.to ?? edge.specifier} (${edge.status})`);
  }
  if (index.graph.cycles.length) {
    lines.push('cycles:');
    for (const cycle of index.graph.cycles) lines.push(`- ${cycle.files.join(' -> ')}`);
  }
  if (index.graph.unresolved.length) {
    lines.push('unresolved dependencies:');
    for (const entry of index.graph.unresolved.slice(0, limit)) {
      lines.push(`- ${entry.from} -> ${entry.specifier} (line ${entry.line})`);
    }
  }
  return lines.join('\n');
}

export async function planProjectHybridRequest(input: ProjectHybridRequestInput): Promise<ProjectHybridResult> {
  const selection = selectProjectContext(input.index, {
    ...(input.filePath ? { filePath: input.filePath } : {}),
    ...(input.query ? { query: input.query } : {}),
    tokenBudget: input.tokenBudget ?? PROJECT_CONTEXT_TOKEN_BUDGET,
  });
  if (!selection.files.length) throw new Error('プロジェクトに解析対象のファイルがありません。');
  const snapshot = buildProjectSnapshot(input.index, selection);
  const plan = await planHybridRequest({
    toolId: input.toolId,
    source: snapshot.text,
    sourceName: `project:${selection.files.length}-files`,
    localAnalysis: projectLocalAnalysis(input.index),
    focusTerms: queryTerms(input.query),
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    ...(input.secrets ? { secrets: input.secrets } : {}),
  });
  return { plan, snapshot, selection };
}
