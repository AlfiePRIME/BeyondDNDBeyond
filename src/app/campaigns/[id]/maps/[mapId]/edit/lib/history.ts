/** One undoable editor action. `apply` performs it again (redo), `revert`
 * reverses it (undo); either may be async when the action wraps database
 * writes (object edits), and both are plain sync for local-only cell edits. */
export interface HistoryEntry {
  apply: () => void | Promise<void>;
  revert: () => void | Promise<void>;
}

export interface HistoryStacks {
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
}

export const EMPTY_HISTORY: HistoryStacks = { past: [], future: [] };

export const HISTORY_LIMIT = 50;

/** A new action forks history: the redo branch is discarded, and the oldest
 * entry falls off once the cap is exceeded. */
export function pushEntry(stacks: HistoryStacks, entry: HistoryEntry): HistoryStacks {
  const past = [...stacks.past, entry];
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    future: [],
  };
}

export function peekUndo(stacks: HistoryStacks): HistoryEntry | null {
  return stacks.past[stacks.past.length - 1] ?? null;
}

export function peekRedo(stacks: HistoryStacks): HistoryEntry | null {
  return stacks.future[stacks.future.length - 1] ?? null;
}

/** Stack movement is separate from entry execution so the caller can commit
 * it only AFTER an async revert succeeded — a failed network write must
 * leave the stacks where they were, keeping the step available to retry. */
export function completeUndo(stacks: HistoryStacks): HistoryStacks {
  const entry = peekUndo(stacks);
  if (!entry) return stacks;
  return { past: stacks.past.slice(0, -1), future: [...stacks.future, entry] };
}

export function completeRedo(stacks: HistoryStacks): HistoryStacks {
  const entry = peekRedo(stacks);
  if (!entry) return stacks;
  return { past: [...stacks.past, entry], future: stacks.future.slice(0, -1) };
}
