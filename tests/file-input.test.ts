/**
 * FIX-020 — file loading.
 *
 * A pick is consumed in one step so the same file can be chosen again after a
 * refused or cancelled load, and a failing read is returned as a message the
 * caller can show instead of escaping as an unhandled rejection.
 */
import { describe, expect, it } from 'vitest';
import { readSourceFile, takeFileInput } from '../src/lib/fileInput';

function fakeInput(files: File[] | null) {
  return { files, value: 'C:\\fakepath\\spec.ts' } as unknown as HTMLInputElement;
}

describe('takeFileInput', () => {
  it('returns the picked file and clears the input so it can be picked again', () => {
    const file = new File(['export const a = 1;'], 'spec.ts', { type: 'text/plain' });
    const input = fakeInput([file]);
    expect(takeFileInput({ target: input })).toBe(file);
    expect(input.value).toBe('');
  });

  it('returns null and still clears the input when the picker was cancelled', () => {
    const input = fakeInput(null);
    expect(takeFileInput({ target: input })).toBeNull();
    expect(input.value).toBe('');
  });
});

describe('readSourceFile', () => {
  it('returns the decoded text', async () => {
    const file = new File(['# Title\n'], 'readme.md', { type: 'text/markdown' });
    await expect(readSourceFile(file)).resolves.toEqual({ text: '# Title\n', error: null });
  });

  it('turns a rejected read into a message instead of an unhandled rejection', async () => {
    const broken = { name: 'moved.ts', text: () => Promise.reject(new Error('not found')) } as unknown as File;
    const result = await readSourceFile(broken);
    expect(result.text).toBeNull();
    expect(result.error).toContain('moved.ts');
  });
});
