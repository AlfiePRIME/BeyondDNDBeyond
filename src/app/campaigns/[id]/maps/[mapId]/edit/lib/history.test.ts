import { describe, expect, it } from "vitest";
import {
  completeRedo,
  completeUndo,
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  peekRedo,
  peekUndo,
  pushEntry,
  type HistoryEntry,
  type HistoryStacks,
} from "./history";

function entry(label: string): HistoryEntry {
  return { apply: () => void label, revert: () => void label };
}

describe("pushEntry", () => {
  it("appends to past and discards the redo branch", () => {
    const undone = entry("undone");
    const stacks: HistoryStacks = { past: [entry("a")], future: [undone] };
    const next = pushEntry(stacks, entry("b"));
    expect(next.past).toHaveLength(2);
    expect(next.future).toHaveLength(0);
  });

  it("drops the oldest entry beyond the cap", () => {
    let stacks = EMPTY_HISTORY;
    const first = entry("first");
    stacks = pushEntry(stacks, first);
    for (let i = 0; i < HISTORY_LIMIT; i++) {
      stacks = pushEntry(stacks, entry(`later-${i}`));
    }
    expect(stacks.past).toHaveLength(HISTORY_LIMIT);
    expect(stacks.past).not.toContain(first);
  });
});

describe("undo/redo movement", () => {
  it("peeks empty stacks as null and completes them as no-ops", () => {
    expect(peekUndo(EMPTY_HISTORY)).toBeNull();
    expect(peekRedo(EMPTY_HISTORY)).toBeNull();
    expect(completeUndo(EMPTY_HISTORY)).toBe(EMPTY_HISTORY);
    expect(completeRedo(EMPTY_HISTORY)).toBe(EMPTY_HISTORY);
  });

  it("moves the newest past entry to future on undo and back on redo", () => {
    const a = entry("a");
    const b = entry("b");
    let stacks = pushEntry(pushEntry(EMPTY_HISTORY, a), b);

    expect(peekUndo(stacks)).toBe(b);
    stacks = completeUndo(stacks);
    expect(stacks.past).toEqual([a]);
    expect(stacks.future).toEqual([b]);

    expect(peekUndo(stacks)).toBe(a);
    stacks = completeUndo(stacks);
    expect(stacks.past).toEqual([]);
    expect(stacks.future).toEqual([b, a]);

    expect(peekRedo(stacks)).toBe(a);
    stacks = completeRedo(stacks);
    expect(stacks.past).toEqual([a]);
    expect(stacks.future).toEqual([b]);

    expect(peekRedo(stacks)).toBe(b);
    stacks = completeRedo(stacks);
    expect(stacks.past).toEqual([a, b]);
    expect(stacks.future).toEqual([]);
  });

  it("a fresh edit after undoing makes the undone entry unreachable", () => {
    const undone = entry("undone");
    let stacks = completeUndo(pushEntry(EMPTY_HISTORY, undone));
    expect(peekRedo(stacks)).toBe(undone);
    stacks = pushEntry(stacks, entry("replacement"));
    expect(peekRedo(stacks)).toBeNull();
  });
});
