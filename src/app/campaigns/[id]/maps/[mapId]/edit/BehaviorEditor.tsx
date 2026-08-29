"use client";

import { useState } from "react";
import { Button, Select, TextInput } from "@/ui-components";
import {
  parseMapObjectBehavior,
  parseObjectMovementConfig,
  type MapObject,
  type MapObjectAction,
  type MapObjectBehavior,
  type ObjectMovementConfig,
} from "@/data-access";
import { SKILLS, type SkillName } from "@/rules-engine";
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
  // Movement Collision & Gated Interaction Checks: true when this object's
  // own cell is a map transition's origin (from_x/from_y) — the call site
  // (MapEditor.tsx) is the one that knows about `transitions`, this
  // component only needs the yes/no answer to decide whether "Required
  // check" is relevant even for an object with NO action configured
  // (a transition's own gate, not this object's). Defaults false so
  // LiveObjectsPanel.tsx's own call site (live-placed session objects,
  // which are never transition origins) needs no change.
  isTransitionOrigin = false,
  onSave,
}: {
  object: MapObject;
  isTransitionOrigin?: boolean;
  onSave: (behavior: MapObjectBehavior | null, movement: ObjectMovementConfig) => void;
}) {
  const saved = parseMapObjectBehavior(object.behavior_config);
  const savedMovement = parseObjectMovementConfig(object.behavior_config);
  const [action, setAction] = useState<MapObjectAction | "">(saved?.action ?? "");
  const [content, setContent] = useState(saved?.content ?? "");
  const [playerTriggerable, setPlayerTriggerable] = useState(saved?.playerTriggerable ?? false);
  // Map Editor Batch A6: opts this object into firing automatically when a
  // token (player OR NPC) lands on its cell, via the exact same
  // trigger_map_object RPC a click uses — independent of playerTriggerable,
  // which only governs manual click-triggering by a non-DM member.
  const [triggerOnStepOn, setTriggerOnStepOn] = useState(saved?.triggerOnStepOn ?? false);
  // Movement Collision & Gated Interaction Checks: null ("Default") defers
  // to the structural preset default (src/scene-3d's isSolidPresetUrl) —
  // see ObjectMovementConfig's own doc comment. Always shown, regardless of
  // whether an action is configured: a plain wall with no action at all
  // still needs this settable.
  const [blocksMovement, setBlocksMovement] = useState<boolean | null>(savedMovement.blocksMovement);
  // "" ("None") means no gate at all — this object's (or, via
  // isTransitionOrigin, this cell's transition's) trigger fires immediately,
  // today's exact existing behavior.
  const [requiredSkill, setRequiredSkill] = useState<SkillName | "">(
    savedMovement.requiredCheck?.skill ?? ""
  );

  const needsContent = action === "reveal_text" || action === "reveal_image";
  // A required check is only ever meaningful when there's something to gate
  // — either this object's own action, or (independently) a transition
  // authored on this exact cell.
  const showRequiredCheck = action !== "" || isTransitionOrigin;

  function handleSave() {
    const movement: ObjectMovementConfig = {
      blocksMovement,
      requiredCheck: requiredSkill === "" ? null : { skill: requiredSkill },
    };
    if (action === "") {
      onSave(null, movement);
      return;
    }
    onSave(
      {
        action,
        content: needsContent ? content : null,
        playerTriggerable,
        triggerOnStepOn,
        // Changing the action invalidates whatever "triggered" meant for the
        // old one; re-saving the same action (message tweak, triggerability
        // flip) keeps the live state as-is.
        triggered: saved !== null && saved.action === action ? saved.triggered : false,
      },
      movement
    );
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
          <Button
            size="sm"
            variant={triggerOnStepOn ? "accent" : "ghost"}
            onClick={() => setTriggerOnStepOn((value) => !value)}
            data-testid="behavior-trigger-on-step-on"
          >
            Trigger on step-on: {triggerOnStepOn ? "yes" : "no"}
          </Button>
        </div>
      ) : null}
      {/* Movement Collision & Gated Interaction Checks: a tri-state, not a
          plain toggle — "Default" (null) is a real, distinct third state
          from "Never" (false), not just the toggle's own starting point,
          since it defers to isSolidPresetUrl's own structural default
          rather than pinning a fixed answer. Shown unconditionally (unlike
          the two buttons above): a plain wall with no action at all still
          needs this settable. */}
      <div className={styles.toolRow}>
        <Button
          size="sm"
          variant={blocksMovement === null ? "accent" : "ghost"}
          onClick={() => setBlocksMovement(null)}
          data-testid="behavior-blocks-movement-default"
        >
          Blocks movement: default
        </Button>
        <Button
          size="sm"
          variant={blocksMovement === true ? "accent" : "ghost"}
          onClick={() => setBlocksMovement(true)}
          data-testid="behavior-blocks-movement-always"
        >
          Always
        </Button>
        <Button
          size="sm"
          variant={blocksMovement === false ? "accent" : "ghost"}
          onClick={() => setBlocksMovement(false)}
          data-testid="behavior-blocks-movement-never"
        >
          Never
        </Button>
      </div>
      {showRequiredCheck ? (
        <Select
          label="Required check"
          value={requiredSkill}
          onChange={(event) => setRequiredSkill(event.target.value as SkillName | "")}
          data-testid="behavior-required-check"
        >
          <option value="">None</option>
          {SKILLS.map((skill) => (
            <option key={skill.name} value={skill.name}>
              {skill.name}
            </option>
          ))}
        </Select>
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
        {saved || savedMovement.blocksMovement !== null || savedMovement.requiredCheck ? (
          <span className={styles.selectedMeta} data-testid="behavior-summary">
            {saved ? `Saved: ${ACTION_LABELS[saved.action]}` : "Saved: no action"}
            {saved ? (saved.playerTriggerable ? " · players can trigger" : " · DM only") : ""}
            {saved?.triggerOnStepOn ? " · fires on step-on" : ""}
            {savedMovement.blocksMovement === true ? " · blocks movement" : ""}
            {savedMovement.blocksMovement === false ? " · never blocks movement" : ""}
            {savedMovement.requiredCheck ? ` · requires ${savedMovement.requiredCheck.skill}` : ""}
          </span>
        ) : null}
      </div>
    </>
  );
}
