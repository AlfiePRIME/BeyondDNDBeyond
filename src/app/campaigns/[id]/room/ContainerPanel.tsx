"use client";

import { Button } from "@/ui-components";
import type { MapObjectItem } from "@/data-access";
import styles from "./room.module.css";

/**
 * Map Editor Batch A4: the Game Room's "you've opened a container" view —
 * a chest's contents (opened by clicking it) or a pit's contents (surfaced
 * automatically to the character who just fell into it, see GameRoom.tsx's
 * handleTokenLanded). Rendered inside a Modal by GameRoom.tsx itself, the
 * same pattern HandoutContent/the transition-offer body already use.
 *
 * `canTake` is false when the viewer has no character of their own in this
 * campaign to receive an item (the DM's own view, or a player who hasn't
 * created one yet) — items are always flavor loot destined for a PC's
 * inventory, never the DM's.
 */
export function ContainerPanel({
  label,
  items,
  canTake,
  busy,
  error,
  onTake,
}: {
  label: string;
  items: MapObjectItem[];
  canTake: boolean;
  busy: boolean;
  error: string | null;
  onTake: (item: MapObjectItem) => void;
}) {
  return (
    <div data-testid="container-panel">
      <p className={styles.hint}>{label}</p>
      {items.length === 0 ? (
        <p className={styles.hint} data-testid="container-panel-empty">
          There&apos;s nothing left here.
        </p>
      ) : (
        <div data-testid="container-panel-items">
          {items.map((item) => (
            <div key={item.id} className={styles.objectRow} data-testid={`container-panel-item-${item.id}`}>
              <div className={styles.objectHeader}>
                <span className={styles.objectName}>{item.name}</span>
              </div>
              {item.description ? <p>{item.description}</p> : null}
              <Button
                size="sm"
                variant="accent"
                disabled={busy || !canTake}
                onClick={() => onTake(item)}
                data-testid={`take-container-item-${item.id}`}
              >
                {busy ? "Taking…" : "Take"}
              </Button>
            </div>
          ))}
        </div>
      )}
      {!canTake ? (
        <p className={styles.hint} data-testid="container-panel-no-character">
          You have no character in this campaign to receive an item.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.errorText} data-testid="container-panel-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
