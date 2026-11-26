/**
 * C05: content types must match what the tools actually emit.
 *
 * The UI's framework/language labels are the source of truth for the supported
 * values; these maps only translate them into artifact content types.
 */

import type { ArtifactContentType } from './types';

export const HARUHI_FRAMEWORKS = ['vitest', 'jest', 'pytest', 'junit5', 'go'] as const;
export type HaruhiFramework = (typeof HARUHI_FRAMEWORKS)[number];

export const TAKANE_LANGUAGES = ['python', 'c', 'cpp', 'mcu'] as const;
export type TakaneLanguage = (typeof TAKANE_LANGUAGES)[number];

export const HARUHI_CONTENT_TYPE_BY_FRAMEWORK = {
  vitest: 'text/x-typescript',
  jest: 'text/x-typescript',
  pytest: 'text/x-python',
  junit5: 'text/x-java',
  go: 'text/x-go',
} as const satisfies Record<HaruhiFramework, ArtifactContentType>;

export const TAKANE_CONTENT_TYPE_BY_LANGUAGE = {
  python: 'text/x-python',
  c: 'text/x-c',
  cpp: 'text/x-cpp',
  mcu: 'text/x-c',
} as const satisfies Record<TakaneLanguage, ArtifactContentType>;

export function contentTypeForHaruhiFramework(framework: HaruhiFramework): ArtifactContentType {
  return HARUHI_CONTENT_TYPE_BY_FRAMEWORK[framework];
}

export function contentTypeForTakaneLanguage(language: TakaneLanguage): ArtifactContentType {
  return TAKANE_CONTENT_TYPE_BY_LANGUAGE[language];
}
