/**
 * Compatibility re-export. The parser now lives in `src/engine/parser/`;
 * existing imports keep working while consumers migrate to the engine entry.
 */

export * from '../engine/parser';
