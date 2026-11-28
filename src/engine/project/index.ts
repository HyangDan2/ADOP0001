import { parseSource } from '../parser';
import type { ParsedModule } from '../parser/types';
import { buildDependencyGraph, normaliseProjectPath } from './dependencies';
import { buildSymbolTable, extractSymbols } from './symbols';
import type {
  ProjectAnalysis,
  ProjectFile,
  ProjectIndex,
  ProjectSkippedFile,
} from './types';

export const PROJECT_INDEX_VERSION = 'adop0001.project-index.v1' as const;

export interface BuildProjectIndexInput {
  files: ProjectFile[];
  skipped?: ProjectSkippedFile[];
  /** A previous index; analyses whose path, hash and language match are reused. */
  previous?: ProjectIndex | null;
}

/**
 * Builds the project index. Parsing is incremental: only files whose SHA-256
 * changed (or that are new) are re-parsed; cross-file resolution and the
 * dependency graph are always recomputed because both depend on the file set.
 */
export function buildProjectIndex(input: BuildProjectIndexInput): ProjectIndex {
  const skipped: ProjectSkippedFile[] = [...(input.skipped ?? [])];
  const byPath = new Map<string, ProjectFile>();
  for (const file of input.files) {
    const path = normaliseProjectPath(file.path);
    if (!path) {
      skipped.push({ path: file.path, reason: 'empty path' });
      continue;
    }
    if (byPath.has(path)) {
      skipped.push({ path, reason: 'duplicate path' });
      continue;
    }
    byPath.set(path, path === file.path ? file : { ...file, path });
  }
  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));

  const previous = new Map<string, ProjectAnalysis>();
  for (const analysis of input.previous?.analyses ?? []) previous.set(analysis.file.path, analysis);

  let reusedFiles = 0;
  let parsedFiles = 0;
  const analyses: ProjectAnalysis[] = files.map((file) => {
    const cached = previous.get(file.path);
    let module: ParsedModule;
    if (cached && cached.file.sha256 === file.sha256 && cached.file.language === file.language) {
      module = cached.module;
      reusedFiles += 1;
    } else {
      module = parseSource(file.path, file.text);
      parsedFiles += 1;
    }
    const { symbols, references } = extractSymbols(file, module);
    return { file, module, symbols, references };
  });

  const symbolTable = buildSymbolTable(analyses);
  const graph = buildDependencyGraph(analyses, files);

  return {
    version: PROJECT_INDEX_VERSION,
    files,
    analyses,
    symbolTable,
    graph,
    stats: {
      fileCount: files.length,
      symbolCount: symbolTable.symbols.length,
      referenceCount: symbolTable.resolutions.length,
      resolved: symbolTable.counts.resolved,
      ambiguous: symbolTable.counts.ambiguous,
      unresolved: symbolTable.counts.unresolved,
      external: symbolTable.counts.external,
      dependencyCount: graph.edges.length,
      unresolvedDependencies: graph.unresolved.length,
      cycleCount: graph.cycles.length,
      reusedFiles,
      parsedFiles,
    },
    skipped,
  };
}
