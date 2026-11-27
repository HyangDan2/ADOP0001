/**
 * CP03 — pane-side capture helper.
 *
 * Keeps the last successful execution context and turns it into a capture
 * request. Capture is fire-and-forget: a slowing artifact store never holds up
 * the UI, and the export guard waits briefly for the snapshot instead.
 */

import { useCallback, useRef } from 'react';
import type { ToolId } from '../../adapters/types';
import type { ExecutionContext } from '../../engine/core/contracts';
import type {
  ArtifactContentInput,
  ArtifactDependency,
  ArtifactSlot,
  InputFingerprint,
} from '../../engine/artifacts/types';
import type { ArtifactBinaryInputDigests } from '../../engine/artifacts/fingerprint';
import type { ValidatorSelectionContext } from '../../engine/artifacts/validation/registry';
import {
  artifactCapture,
  composeCaptureFingerprint,
  type ArtifactCaptureResult,
} from '../../lib/artifacts/capture';

export interface PaneCapturePlan {
  contents: ArtifactContentInput[];
  /** The pane's own freshness check; false supersedes the capture. */
  isCurrent: () => boolean;
  inputRevision: number;
  binaryInputs?: ArtifactBinaryInputDigests;
  validationContext?: ValidatorSelectionContext;
  sourceName?: string;
  forceAppend?: boolean;
  /** Resolved just before capture; an empty list omits the dependency edge. */
  dependencies?: () => Promise<ArtifactDependency[]>;
}

export interface PaneArtifactCapture<K extends ToolId> {
  remember(context: ExecutionContext<K>): void;
  /**
   * Fire-and-forget; the returned promise settles with the stored capture (or
   * null when superseded), so a dependent slot can name the exact revision.
   */
  capture(plan: PaneCapturePlan): Promise<ArtifactCaptureResult | null>;
  liveFingerprint(
    binaryInputs?: ArtifactBinaryInputDigests,
    sourceName?: string,
  ): Promise<InputFingerprint | null>;
  hasContext(): boolean;
}

export function useArtifactCapture<K extends ToolId>(slot: ArtifactSlot): PaneArtifactCapture<K> {
  const contextRef = useRef<ExecutionContext<K> | null>(null);
  /** The exact identity additions the last capture used, for live drift checks. */
  const identityRef = useRef<{
    binaryInputs?: ArtifactBinaryInputDigests;
    sourceName?: string;
  }>({});

  const remember = useCallback((context: ExecutionContext<K>) => {
    contextRef.current = context;
  }, []);

  const capture = useCallback(
    (plan: PaneCapturePlan) => {
      const context = contextRef.current;
      if (!context) return Promise.resolve(null);
      identityRef.current = { binaryInputs: plan.binaryInputs, sourceName: plan.sourceName };
      const { dependencies: resolveDependencies, ...capturePlan } = plan;
      return (async () => {
        const dependencies = resolveDependencies ? await resolveDependencies() : undefined;
        if (!plan.isCurrent()) return null;
        return artifactCapture().capture({
          slot,
          context,
          ...capturePlan,
          ...(dependencies && dependencies.length ? { dependencies } : {}),
        });
      })().catch((cause) => {
        // The export guard surfaces the missing artifact to the user; the
        // console keeps the underlying repository failure diagnosable.
        console.warn('[artifact] capture failed', cause);
        return null;
      });
    },
    [slot],
  );

  const liveFingerprint = useCallback(
    async (binaryInputs?: ArtifactBinaryInputDigests, sourceName?: string) => {
      const context = contextRef.current;
      if (!context) return null;
      return composeCaptureFingerprint({
        context,
        binaryInputs: binaryInputs ?? identityRef.current.binaryInputs,
        sourceName: sourceName ?? identityRef.current.sourceName,
      });
    },
    [],
  );

  const hasContext = useCallback(() => contextRef.current !== null, []);

  return { remember, capture, liveFingerprint, hasContext };
}
