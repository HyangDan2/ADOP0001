/**
 * PATCH-006 — artifact revision guard.
 *
 * A tool bumps its input revision whenever the input that an output was
 * computed from changes (source, file name, options). The output records the
 * revision it was produced from, and an export compares the two at the moment
 * the file is written. That blocks an artifact generated from older input even
 * when the export modal was opened before the edit, because the comparison
 * happens on the click, not when the modal mounted.
 */
export function assertArtifactRevision(inputRevision: number, outputRevision: number | null): void {
  if (outputRevision === null) {
    throw new Error('まだ書き出せる成果物がありません。入力から再生成してください。');
  }
  if (outputRevision !== inputRevision) {
    throw new Error('入力が変更されています。再生成してから書き出してください。');
  }
}
