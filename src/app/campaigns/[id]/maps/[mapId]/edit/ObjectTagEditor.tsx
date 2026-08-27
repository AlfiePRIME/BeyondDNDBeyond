"use client";

import { useState } from "react";
import { Button, TextInput } from "@/ui-components";
import type { MapObject } from "@/data-access";
import styles from "./editor.module.css";

/**
 * Map Editor Batch A6: a freeform, optional label the DM can set on any
 * placed object — copied into every interaction_events row this object's
 * triggers (click or step-on) produce, so an event can be attributed to a
 * human-readable name regardless of what kind of object caused it.
 *
 * Mount keyed by the object's id (BehaviorEditor's own pattern) so
 * switching selection resets the draft to that object's saved tag.
 */
export function ObjectTagEditor({
  object,
  onSave,
}: {
  object: MapObject;
  onSave: (tag: string | null) => void;
}) {
  const [tag, setTag] = useState(object.tag ?? "");
  const trimmed = tag.trim();
  const saved = object.tag ?? "";
  const dirty = trimmed !== saved;

  return (
    <div className={styles.toolRow}>
      <TextInput
        label="Tag (for the activity feed)"
        value={tag}
        onChange={(event) => setTag(event.target.value)}
        placeholder="e.g. Vault door"
        data-testid="object-tag-input"
      />
      <Button
        size="sm"
        variant="teal"
        disabled={!dirty}
        onClick={() => onSave(trimmed === "" ? null : trimmed)}
        data-testid="object-tag-save"
      >
        Save tag
      </Button>
    </div>
  );
}
