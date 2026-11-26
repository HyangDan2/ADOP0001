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

/**
 * WO-11 — the apply-time twin of the export guard.
 *
 * An AI proposal was written against the local artifact that existed when the
 * request started. If the pane has produced a different artifact since (a
 * re-run with new options, a reset), the proposal no longer describes what is
 * on screen and must not be merged into it.
 */
export function assertSameArtifact(base: unknown, current: unknown): void {
  if (base !== current) {
    throw new Error(
      'AI 補完の対象だったローカル結果が更新されました。この提案は適用できません。もう一度事前確認から実行してください。',
    );
  }
}
