"use client";

import { useEffect, useState } from "react";
import { Button, Modal } from "@/ui-components";
import styles from "./room.module.css";

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Click token → click cell", action: "Select a token, then move it" },
  { keys: "R", action: "Rotate the selected token 90°" },
  { keys: "Esc", action: "Cancel the current selection" },
  { keys: "← ↑ → ↓", action: "Look around from your seat" },
  { keys: "Free camera + drag", action: "Orbit the table (right-drag pans, wheel zooms)" },
  { keys: "Enter", action: "Send a chat message" },
  { keys: "?", action: "Show this list" },
];

/**
 * A "?" button (and the ? key) listing the table's controls — none of them
 * are otherwise discoverable from the UI.
 */
export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      setOpen((current) => !current);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label="Controls and keyboard shortcuts"
        title="Controls and keyboard shortcuts (?)"
        data-testid="shortcuts-help-button"
      >
        ?
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Table controls">
        <dl className={styles.shortcutList}>
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className={styles.shortcutRow}>
              <dt>
                <kbd className={styles.shortcutKeys}>{shortcut.keys}</kbd>
              </dt>
              <dd>{shortcut.action}</dd>
            </div>
          ))}
        </dl>
      </Modal>
    </>
  );
}
