import type { EngineAdapter, ToolId } from './types';
import { ShioriAdapter } from '../tools/shiori/adapter';
import { YayoiAdapter } from '../tools/yayoi/adapter';
import { KozueAdapter } from '../tools/kozue/adapter';
import { HaruhiAdapter } from '../tools/haruhi/adapter';
import { KotohaAdapter } from '../tools/kotoha/adapter';

export interface ToolMeta {
  id: ToolId;
  path: string;
  japanese: string;
  english: string;
  tagline: string;
  longDescription: string;
  adapter: EngineAdapter<never, never>;
}

/**
 * Engine registry. Every tool is resolved through this table, so a future
 * `hybrid-ai` adapter can replace a `local-static` one without touching the UI.
 */
export const TOOLS: ToolMeta[] = [
  {
    id: 'shiori',
    path: '#/shiori',
    japanese: '枝織',
    english: 'Specification Writer',
    tagline: 'Weave source code into a contract-grade specification.',
    longDescription:
      'Parses TypeScript, JavaScript, Python, Java and Go to extract modules, types, signatures, guards, error paths and dependencies, then writes a contract table and behaviour rules as Markdown or standalone HTML.',
    adapter: new ShioriAdapter() as unknown as EngineAdapter<never, never>,
  },
  {
    id: 'yayoi',
    path: '#/yayoi',
    japanese: '弥生',
    english: 'Pseudocode Studio',
    tagline: 'Strip the syntax, keep the thinking.',
    longDescription:
      'Removes language noise and keeps control flow as readable pseudocode in three styles, with detailed or summary depth and line-level highlighting tied back to the original source.',
    adapter: new YayoiAdapter() as unknown as EngineAdapter<never, never>,
  },
  {
    id: 'kozue',
    path: '#/kozue',
    japanese: '梢絵',
    english: 'UML Auto-Architect',
    tagline: 'Let the code choose its own diagram.',
    longDescription:
      'Scores five UML kinds from the source structure, explains why one fits best, and renders Sequence, Class, State, Activity or Component diagrams with Mermaid — pan, zoom and SVG/PNG export included.',
    adapter: new KozueAdapter() as unknown as EngineAdapter<never, never>,
  },
  {
    id: 'haruhi',
    path: '#/haruhi',
    japanese: '春日',
    english: 'Test Case Forge',
    tagline: 'Forge the cases the code implies.',
    longDescription:
      'Derives happy paths, boundary values, guard branches and error paths from the source, then emits Given/When/Then skeletons for Vitest/Jest, Pytest, JUnit 5 and Go testing with an uncovered-branch checklist.',
    adapter: new HaruhiAdapter() as unknown as EngineAdapter<never, never>,
  },
  {
    id: 'kotoha',
    path: '#/kotoha',
    japanese: '琴葉',
    english: 'Docx ↔ MD Round-Trip',
    tagline: 'Edit the words, keep the template.',
    longDescription:
      'Decomposes a .docx into clean Markdown while preserving styles, theme, numbering, headers, footers, media and page geometry in a style bundle, then rebuilds a valid .docx that still looks like the original.',
    adapter: new KotohaAdapter() as unknown as EngineAdapter<never, never>,
  },
];

export function toolById(id: string | undefined): ToolMeta {
  return TOOLS.find((tool) => tool.id === id) ?? TOOLS[0];
}

export function toolFromHash(hash: string): ToolMeta {
  const match = hash.match(/^#\/([a-z]+)/);
  return toolById(match?.[1]);
}
