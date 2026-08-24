"use client";

import { useState } from "react";
import { Button, Select, TextInput } from "@/ui-components";
import {
  parseMapObjectBehavior,
  type MapObject,
  type MapObjectAction,
  type MapObjectBehavior,
} from "@/data-access";
import styles from "./editor.module.css";

const ACTION_LABELS: Record<MapObjectAction, string> = {
  reveal_text: "Reveal text",
  reveal_image: "Reveal image",
  toggle_visibility: "Appear / disappear",
  toggle_state: "On / off switch",
};

/**
 * Behavior configuration for the selected object — mount keyed by the
 * object's id so switching selection resets the draft to that object's
 * saved config.
 */
export function BehaviorEditor({
  object,
  onSave,
}: {
  object: MapObject;
  onSave: (behavior: MapObjectBehavior | null) => void;
}) {
  const saved = parseMapObjectBehavior(object.behavior_config);
  const [action, setAction] = useState<MapObjectAction | "">(saved?.action ?? "");
  const [content, setContent] = useState(saved?.content ?? "");
  const [playerTriggerable, setPlayerTriggerable] = useState(saved?.playerTriggerable ?? false);

  const needsContent = action === "reveal_text" || action === "reveal_image";

  function handleSave() {
    if (action === "") {
      onSave(null);
      return;
    }
    onSave({
      action,
      content: needsContent ? content : null,
      playerTriggerable,
      // Changing the action invalidates whatever "triggered" meant for the
      // old one; re-saving the same action (message tweak, triggerability
      // flip) keeps the live state as-is.
      triggered: saved !== null && saved.action === action ? saved.triggered : false,
    });
  }

  return (
    <>
      <span className={styles.toolbarLabel}>Behavior</span>
      <Select
        label="Action"
        value={action}
        onChange={(event) => setAction(event.target.value as MapObjectAction | "")}
        data-testid="behavior-action"
      >
        <option value="">None (inert prop)</option>
        {Object.entries(ACTION_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      {needsContent ? (
        <TextInput
          label={action === "reveal_text" ? "Hidden message" : "Image URL"}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={action === "reveal_text" ? "You find 30 gold pieces…" : "https://…"}
          data-testid="behavior-content"
        />
      ) : null}
      {action !== "" ? (
        <div className={styles.toolRow}>
          <Button
            size="sm"
            variant={playerTriggerable ? "accent" : "ghost"}
            onClick={() => setPlayerTriggerable((value) => !value)}
            data-testid="behavior-player-triggerable"
          >
            Players can trigger: {playerTriggerable ? "yes" : "no"}
          </Button>
        </div>
      ) : null}
      <div className={styles.toolRow}>
        <Button
          size="sm"
          variant="teal"
          disabled={needsContent && content.trim() === ""}
          onClick={handleSave}
          data-testid="behavior-save"
        >
          Save behavior
        </Button>
        {saved ? (
          <span className={styles.selectedMeta} data-testid="behavior-summary">
            Saved: {ACTION_LABELS[saved.action]}
            {saved.playerTriggerable ? " · players can trigger" : " · DM only"}
          </span>
        ) : null}
      </div>
    </>
  );
}
