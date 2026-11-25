/**
 * WO-10 — the tool registry.
 *
 * Stage 1 (pilot): Shiori, Haruhi — implemented and regression-tested first.
 * Stage 2: Yayoi, Kozue, Kotoha, Takane.
 *
 * Every row is a `ToolHybridSpec`; the orchestrator only knows this interface, so
 * a tool without a spec can never be sent to a model.
 */

import type { ToolId } from '../../../adapters/types';
import { haruhiSpec } from './haruhi';
import { kotohaSpec } from './kotoha';
import { kozueSpec } from './kozue';
import { shioriSpec } from './shiori';
import { takaneSpec } from './takane';
import { yayoiSpec } from './yayoi';
import type { ToolHybridSpec } from './types';

const SPECS: { [K in ToolId]: ToolHybridSpec<K> } = {
  shiori: shioriSpec,
  haruhi: haruhiSpec,
  yayoi: yayoiSpec,
  kozue: kozueSpec,
  kotoha: kotohaSpec,
  takane: takaneSpec,
};

export function toolHybridSpec<K extends ToolId>(toolId: K): ToolHybridSpec<K> {
  return SPECS[toolId];
}

export const HYBRID_TOOL_IDS: ToolId[] = ['shiori', 'haruhi', 'yayoi', 'kozue', 'kotoha', 'takane'];

export type { ToolHybridSpec };
