import { draftLabel, type DraftState } from '../lib/drafts';

/** Small status-bar badge that says whether this tool's draft is stored. */
export function DraftStateBadge({ state }: { state: DraftState }) {
  return (
    <span data-testid="draft-state" className={state.error ? 'err' : undefined} title={state.error ?? undefined}>
      {draftLabel(state)}
    </span>
  );
}
