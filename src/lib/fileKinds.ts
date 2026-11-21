/**
 * File-kind helpers shared by the tool panes, the few-shot manager and the
 * workspace rail. File names and accept lists stay English so a user can open
 * the same files from a shell, an editor or this app.
 */
import type { ToolId } from '../adapters/types';

/** Every source file a code tool accepts: web, Python, C/C++, MCU, JVM, Go and text. */
export const CODE_FILE_ACCEPT =
  '.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.c,.cpp,.cc,.cxx,.h,.hpp,.ino,.java,.go,.txt,.md';

/** The same list plus Markdown variants, for the specification tools. */
export const SPEC_FILE_ACCEPT = `${CODE_FILE_ACCEPT},.markdown`;

/** Documents the round-trip tool understands. */
export const DOCX_FILE_ACCEPT = '.docx';

/** Everything the few-shot manager accepts as an example file. */
export const FEW_SHOT_FILE_ACCEPT = `${SPEC_FILE_ACCEPT},.json,.hxx,.hh,.ipp,.tpp`;

/** Extensions a code tool (枝織/弥生/梢絵/春日) can analyse. */
const CODE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx', 'hh', 'ino', 'ipp', 'tpp',
  'java', 'go', 'json',
];

const SPEC_EXTENSIONS = ['md', 'markdown', 'txt'];
const DOCX_EXTENSIONS = ['docx'];

export function extensionOf(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function isCodeFile(fileName: string): boolean {
  return CODE_EXTENSIONS.includes(extensionOf(fileName));
}

export function isSpecFile(fileName: string): boolean {
  return SPEC_EXTENSIONS.includes(extensionOf(fileName));
}

export function isDocxFile(fileName: string): boolean {
  return DOCX_EXTENSIONS.includes(extensionOf(fileName));
}

/** Binary documents cannot be stored as few-shot text Examples. */
export function isBinaryFile(fileName: string): boolean {
  return isDocxFile(fileName) || ['pdf', 'png', 'jpg', 'jpeg', 'zip', 'exe', 'bin'].includes(extensionOf(fileName));
}

/** A default few-shot language tag derived from the file extension. */
export function languageTagFor(fileName: string): string | undefined {
  switch (extensionOf(fileName)) {
    case 'py':
      return 'python';
    case 'c':
      return 'c';
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'h':
    case 'hpp':
    case 'hxx':
    case 'hh':
    case 'ipp':
    case 'tpp':
      return 'cpp';
    case 'ino':
      return 'mcu';
    default:
      return undefined;
  }
}

const CODE_TOOLS: ToolId[] = ['shiori', 'yayoi', 'kozue', 'haruhi'];

/**
 * Which tool should receive a file opened from the workspace rail.
 * Markdown and text go to 貴音 (specifications), `.docx` to 琴葉, code to the
 * active code tool (枝織 when the active tool is not a code tool).
 */
export function targetToolForFile(fileName: string, activeToolId: ToolId): ToolId {
  if (isDocxFile(fileName)) return 'kotoha';
  if (isSpecFile(fileName)) return 'takane';
  if (isCodeFile(fileName)) return CODE_TOOLS.includes(activeToolId) ? activeToolId : 'shiori';
  return activeToolId;
}
