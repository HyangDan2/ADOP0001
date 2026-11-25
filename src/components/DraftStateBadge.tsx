import { draftLabel, draftStorageDetail, type DraftState } from '../lib/drafts';

/**
 * Small status-bar badge that says whether this tool's draft is stored.
 *
 * WO-02: the tooltip distinguishes a refused IndexedDB access from a browser that has no
 * IndexedDB at all, so a degraded save is not silent and a memory-only environment is not
 * reported as an incident.
 */
export function DraftStateBadge({ state }: { state: DraftState }) {
  const detail = draftStorageDetail(state);
  return (
    <span
      data-testid="draft-state"
      data-storage={state.storage ?? 'none'}
      data-idb={state.idb ?? 'unknown'}
      className={state.error ? 'err' : undefined}
      title={detail ?? undefined}
    >
      {draftLabel(state)}
    </span>
  );
}
