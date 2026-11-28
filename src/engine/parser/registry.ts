import type { Lang, ParsedModule, SourceDiagnostic } from './types';
import type { Masked } from './tokenizer';
import { parseJsLike } from './typescript';
import { parsePython } from './python';
import { parseJava } from './java';
import { parseGo } from './go';
import { parseCFamily } from './cfamily';

/** Language parser registry (WO-E02): extension map plus ordered content probes. */

export interface LanguageParser {
  language: Lang;
  label: string;
  extensions: readonly string[];
  /** Content probe used only when the extension does not decide. */
  detect?: (source: string) => boolean;
  parse: (module: ParsedModule, mask: Masked, diagnostics: SourceDiagnostic[]) => void;
}

export const LANGUAGE_PARSERS: readonly LanguageParser[] = [
  {
    language: 'go',
    label: 'Go',
    extensions: ['go'],
    detect: (source) => /^\s*package\s+\w+/m.test(source) && /func\s+\w+\s*\(/.test(source),
    parse: parseGo,
  },
  {
    language: 'csharp',
    label: 'C#',
    extensions: ['cs', 'csx'],
    detect: (source) =>
      /^\s*using\s+System(?:[.;]|\s)/m.test(source) ||
      (/^\s*namespace\s+[\w.]+/m.test(source) && /\bclass\s+\w+/.test(source)),
    parse: (module, mask, diagnostics) => parseCFamily(module, mask, diagnostics, 'csharp'),
  },
  {
    language: 'cpp',
    label: 'C++',
    extensions: ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h'],
    detect: (source) =>
      /#\s*include\s*[<"]/.test(source) &&
      /(?:std::|namespace\s+\w+|template\s*<|class\s+\w+\s*[:{])/.test(source),
    parse: (module, mask, diagnostics) => parseCFamily(module, mask, diagnostics, 'cpp'),
  },
  {
    language: 'c',
    label: 'C',
    extensions: ['c'],
    detect: (source) => /#\s*include\s*[<"]/.test(source),
    parse: (module, mask, diagnostics) => parseCFamily(module, mask, diagnostics, 'c'),
  },
  {
    language: 'java',
    label: 'Java',
    extensions: ['java'],
    detect: (source) =>
      /(^|\n)\s*(public|private|protected)\s+\w+[\w<>[\], ]*\s+\w+\s*\(/m.test(source),
    parse: parseJava,
  },
  {
    language: 'python',
    label: 'Python',
    extensions: ['py', 'pyw'],
    detect: (source) => /(^|\n)\s*(?:async\s+)?def\s+\w+\s*\(/m.test(source),
    parse: parsePython,
  },
  {
    language: 'typescript',
    label: 'TypeScript',
    extensions: ['ts', 'tsx', 'mts', 'cts'],
    detect: (source) => /interface\s+\w+|:\s*(string|number|boolean)\b/.test(source),
    parse: parseJsLike,
  },
  {
    language: 'javascript',
    label: 'JavaScript',
    extensions: ['js', 'jsx', 'mjs', 'cjs'],
    detect: (source) => /(^|\n)\s*(const|let|var|function)\s/.test(source),
    parse: parseJsLike,
  },
];

const BY_EXTENSION = new Map<string, LanguageParser>();
const BY_LANGUAGE = new Map<Lang, LanguageParser>();
for (const parser of LANGUAGE_PARSERS) {
  BY_LANGUAGE.set(parser.language, parser);
  for (const extension of parser.extensions) BY_EXTENSION.set(extension, parser);
}

export function parserFor(language: Lang): LanguageParser | undefined {
  return BY_LANGUAGE.get(language);
}

export function extensionOf(fileName: string): string {
  return fileName.toLowerCase().match(/\.([a-z0-9+#]+)$/)?.[1] ?? '';
}

export function languageFromExtension(fileName: string): Lang | undefined {
  return BY_EXTENSION.get(extensionOf(fileName))?.language;
}

export function languageLabel(lang: Lang): string {
  return parserFor(lang)?.label ?? 'Unknown';
}
