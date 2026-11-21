/**
 * Opened-file bus between the PC workspace rail and the tool panes.
 *
 * A file can be opened before its tool mounts (the rail also switches tools),
 * so a delivery with no listener is queued and handed over on subscribe.
 */
import { useEffect, useRef } from 'react';
import type { ToolId } from '../adapters/types';
import { isBinaryFile } from './fileKinds';

export interface OpenedFile {
  /** Unique delivery id, so a tool can ignore a repeat of the same file. */
  id: string;
  /** Workspace path (`src/app.ts`) or the bare file name. */
  path: string;
  name: string;
  text: string;
  /** The original `File`, needed by 琴葉 for `.docx` bytes. */
  file: File;
}

const listeners = new Map<ToolId, Set<(payload: OpenedFile) => void>>();
const pending = new Map<ToolId, OpenedFile[]>();

export function publishOpenedFile(toolId: ToolId, payload: OpenedFile): void {
  const set = listeners.get(toolId);
  if (set && set.size) {
    for (const listener of set) listener(payload);
    return;
  }
  const queue = pending.get(toolId) ?? [];
  queue.push(payload);
  pending.set(toolId, queue.slice(-4));
}

export function subscribeOpenedFile(toolId: ToolId, handler: (payload: OpenedFile) => void): () => void {
  const set = listeners.get(toolId) ?? new Set();
  set.add(handler);
  listeners.set(toolId, set);
  const queue = pending.get(toolId);
  if (queue && queue.length) {
    pending.delete(toolId);
    for (const payload of queue) handler(payload);
  }
  return () => {
    set.delete(handler);
    if (!set.size) listeners.delete(toolId);
  };
}

/** Subscribes a tool pane to files opened from the workspace rail. */
export function useOpenedFile(toolId: ToolId, handler: (payload: OpenedFile) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribeOpenedFile(toolId, (payload) => ref.current(payload)), [toolId]);
}

/** Creates the payload for a workspace/file-picker selection. */
export async function openedFileFrom(file: File, path?: string): Promise<OpenedFile> {
  const resolvedPath = path ?? file.name;
  const name = resolvedPath.split('/').pop() ?? file.name;
  const text = isBinaryFile(name) ? '' : await file.text();
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    path: resolvedPath,
    name,
    text,
    file,
  };
}
