/**
 * File-picker helpers shared by every tool pane (FIX-020).
 *
 * A picked file is taken *and the input cleared* in one step: leaving the value
 * set means re-picking the same file (for example after a refused or cancelled
 * load) fires no `change` event at all, and the tool looks unresponsive.
 *
 * Reading a `File` can reject (the file was moved, the sandbox revoked access).
 * The failure is returned as a message so the caller can show it, instead of
 * escaping as an unhandled rejection with no UI feedback.
 */

export function takeFileInput(event: { target: HTMLInputElement }): File | null {
  const file = event.target.files?.[0] ?? null;
  event.target.value = '';
  return file;
}

export type SourceFileRead = { text: string; error: null } | { text: null; error: string };

export async function readSourceFile(file: File): Promise<SourceFileRead> {
  try {
    return { text: await file.text(), error: null };
  } catch {
    return { text: null, error: `ファイルを読み取れませんでした（${file.name}）。` };
  }
}
