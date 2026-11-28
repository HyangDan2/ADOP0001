import type { ToolId } from '../../adapters/types';
import type { ProjectIndex } from '../../engine/project/types';
import type { ProjectContextSelection } from '../../engine/project/context';

/** WO-E07 — project snapshots and per-tool bundles for the six tools. */

export const PROJECT_SNAPSHOT_VERSION = 'adop0001.project-snapshot.v1';

export interface ProjectToolDescriptor {
  toolId: ToolId;
  title: string;
  guidance: string;
}

export const PROJECT_TOOLS: readonly ProjectToolDescriptor[] = [
  { toolId: 'shiori', title: 'プロジェクト仕様書', guidance: '選択したファイルから仕様（責務・入出力・制約）を整理する。' },
  { toolId: 'yayoi', title: 'プロジェクト擬似コード', guidance: '呼び出し関係に沿って処理手順を擬似コード化する。' },
  { toolId: 'kozue', title: 'プロジェクト UML', guidance: 'シンボル表と依存関係からクラス図・依存図を作成する。' },
  { toolId: 'haruhi', title: 'プロジェクトテスト', guidance: '公開シンボルと境界条件からテスト観点を導出する。' },
  { toolId: 'kotoha', title: 'プロジェクト文書', guidance: 'Markdown と DOCX の往復に適した構造で文書化する。' },
  { toolId: 'takane', title: 'プロジェクト実装', guidance: '仕様とシンボル表から実装方針とコードを示す。' },
];

export interface ProjectSnapshot {
  version: typeof PROJECT_SNAPSHOT_VERSION;
  text: string;
  files: { path: string; sha256: string; language: string }[];
  tokens: number;
  selection: ProjectContextSelection;
}

export function buildProjectSnapshot(index: ProjectIndex, selection: ProjectContextSelection): ProjectSnapshot {
  const lines: string[] = [
    `# ${PROJECT_SNAPSHOT_VERSION}`,
    `# files=${index.stats.fileCount} symbols=${index.stats.symbolCount} references=${index.stats.referenceCount}`,
    `# dependencies=${index.stats.dependencyCount} cycles=${index.stats.cycleCount} unresolved=${index.stats.unresolvedDependencies}`,
    `# context=${selection.files.length} files tokens=${selection.tokens}/${selection.budget}`,
    '',
  ];
  for (const file of selection.files) {
    lines.push(`## FILE: ${file.path} (${file.language}) sha256=${file.sha256.slice(0, 12)}`);
    lines.push(`<!-- reason=${file.reason}${file.truncated ? ' truncated' : ''} -->`);
    lines.push('```' + file.language);
    lines.push(file.excerpt);
    lines.push('```', '');
  }
  for (const entry of selection.excluded) {
    lines.push(`<!-- excluded: ${entry.path} (${entry.reason}) -->`);
  }
  return {
    version: PROJECT_SNAPSHOT_VERSION,
    text: lines.join('\n'),
    files: selection.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      language: file.language,
    })),
    tokens: selection.tokens,
    selection,
  };
}

export function buildProjectToolBundle(
  descriptor: ProjectToolDescriptor,
  index: ProjectIndex,
  selection: ProjectContextSelection,
): string {
  const cycles = index.graph.cycles.map((cycle) => cycle.files.join(' → '));
  const unresolved = index.graph.unresolved.map((entry) => `${entry.from} → ${entry.specifier} (line ${entry.line})`);
  const sections: string[] = [
    `# ${descriptor.title}`,
    descriptor.guidance,
    '',
    '## プロジェクト概要',
    `- ファイル: ${index.stats.fileCount}`,
    `- シンボル: ${index.stats.symbolCount}（解決 ${index.stats.resolved} / 曖昧 ${index.stats.ambiguous} / 未解決 ${index.stats.unresolved} / 外部 ${index.stats.external}）`,
    `- 依存: ${index.stats.dependencyCount}（未解決 ${index.stats.unresolvedDependencies}）`,
    `- 循環: ${cycles.length ? cycles.join('; ') : 'なし'}`,
    ...(unresolved.length ? ['', '## 未解決依存', ...unresolved.map((entry) => `- ${entry}`)] : []),
    '',
    '## 収集コンテキスト',
    ...selection.files.map(
      (file) => `- ${file.path}（${file.reason}${file.truncated ? ' / 抜粋' : ''}, ~${file.tokens} tokens）`,
    ),
    '',
    '## ソース',
  ];
  for (const file of selection.files) {
    sections.push(`### ${file.path}`, '```' + file.language, file.excerpt, '```', '');
  }
  return sections.join('\n');
}

export function buildProjectToolBundles(
  index: ProjectIndex,
  selection: ProjectContextSelection,
): { toolId: ToolId; title: string; text: string }[] {
  return PROJECT_TOOLS.map((descriptor) => ({
    toolId: descriptor.toolId,
    title: descriptor.title,
    text: buildProjectToolBundle(descriptor, index, selection),
  }));
}
