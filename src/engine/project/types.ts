import type { Lang, ParsedModule } from '../parser/types';

/** Phase 5E project analysis model (WO-E01, WO-E03, WO-E04). */

export interface ProjectFile {
  /** POSIX-style path relative to the project root. */
  path: string;
  text: string;
  language: Lang;
  byteLength: number;
  /** SHA-256 of the UTF-8 bytes; the incremental cache key. */
  sha256: string;
}

export interface ProjectSkippedFile {
  path: string;
  reason: string;
}

export interface ProjectSourceSet {
  files: ProjectFile[];
  skipped: ProjectSkippedFile[];
}

export type ProjectSymbolKind = 'function' | 'method' | 'type' | 'global' | 'member';

export interface ProjectSymbol {
  id: string;
  name: string;
  kind: ProjectSymbolKind;
  language: Lang;
  filePath: string;
  line: number;
  endLine?: number;
  owner?: string;
  exported: boolean;
  signature?: string;
}

export type ReferenceKind = 'call' | 'type';

export interface SymbolReference {
  name: string;
  kind: ReferenceKind;
  filePath: string;
  line: number;
  fromSymbolId?: string;
}

export type ResolutionStatus = 'resolved' | 'ambiguous' | 'unresolved' | 'external';

export interface ResolvedReference extends SymbolReference {
  status: ResolutionStatus;
  targets: string[];
}

export interface ProjectSymbolTable {
  symbols: ProjectSymbol[];
  resolutions: ResolvedReference[];
  counts: Record<ResolutionStatus, number>;
}

export type DependencyKind = 'imports' | 'includes' | 'using';
export type DependencyStatus = 'resolved' | 'external' | 'unresolved';

export interface ProjectDependencyEdge {
  from: string;
  to: string | null;
  specifier: string;
  line: number;
  kind: DependencyKind;
  status: DependencyStatus;
}

export interface ProjectCycle {
  files: string[];
}

export interface ProjectDependencyGraph {
  edges: ProjectDependencyEdge[];
  cycles: ProjectCycle[];
  unresolved: { from: string; specifier: string; line: number }[];
}

export interface ProjectAnalysis {
  file: ProjectFile;
  module: ParsedModule;
  symbols: ProjectSymbol[];
  references: SymbolReference[];
}

export interface ProjectIndexStats {
  fileCount: number;
  symbolCount: number;
  referenceCount: number;
  resolved: number;
  ambiguous: number;
  unresolved: number;
  external: number;
  dependencyCount: number;
  unresolvedDependencies: number;
  cycleCount: number;
  reusedFiles: number;
  parsedFiles: number;
}

export interface ProjectIndex {
  version: 'adop0001.project-index.v1';
  files: ProjectFile[];
  analyses: ProjectAnalysis[];
  symbolTable: ProjectSymbolTable;
  graph: ProjectDependencyGraph;
  stats: ProjectIndexStats;
  skipped: ProjectSkippedFile[];
}
