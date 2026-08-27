"use client";

import { useRef, useState } from "react";
import { Badge, Button, type BadgeTone } from "@/ui-components";
import {
  createCustomAsset,
  getMapAssetSignedUrl,
  setForwardOffsetDeg,
  uploadMapAssetFile,
  type MonsterAttack,
  type MonsterStatBlock,
  type MonsterTemplate,
  type Npc,
  type TokenAllegiance,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { validateGlbFile } from "@/app/lib/validate-glb";
import { ModelOrientationStep } from "@/app/ModelOrientationStep";
import { PLACED_OBJECT_SIZE } from "@/scene-3d";
import type { PaletteAsset } from "../maps/[mapId]/edit/lib/assetUrl";
import styles from "./room.module.css";

/** One attack row's form drafts — parsed/validated only on save. */
interface AttackDraft {
  name: string;
  bonus: string;
  damageNotation: string;
}

const EMPTY_ATTACK: AttackDraft = { name: "", bonus: "", damageNotation: "" };

/** TokenPanel's own ALLEGIANCE_TONE mapping, duplicated here rather than
 * shared — both are small, page-local presentational lookups, not a
 * data-access concern worth a shared module for three entries. */
const ALLEGIANCE_TONE: Record<TokenAllegiance, BadgeTone> = {
  party: "teal",
  hostile: "red",
  neutral: "orange",
};

function formatAttackSummary(attacks: MonsterAttack[]): string {
  return attacks
    .map((attack) => `${attack.name} ${attack.bonus >= 0 ? "+" : ""}${attack.bonus} (${attack.damageNotation})`)
    .join(" · ");
}

/**
 * The DM's monster tooling (Prompt 61), a DM-ONLY side panel (GameRoom
 * never renders it for players, and 0038's RLS rejects a non-DM hitting
 * the table directly regardless): create/edit/list the campaign's
 * lightweight stat blocks — name, HP, AC, passive Perception, and a small
 * repeatable list of attacks (name + flat bonus + damage notation, the
 * numbers the roll route uses directly) — deliberately nothing like full
 * character creation. "Start from roster NPC" pre-fills the name from a
 * Prompt 33 narrative NPC rather than re-typing it (the task's own
 * "promote" convenience — a name pre-fill, nothing more). Each block's
 * "Quick add" arms the ordinary grid-click token placement; GameRoom
 * finishes the flow — placing the token (npc_name populated from the
 * block's name, monster_stat_block_id linked) and, if combat is active,
 * prompting for initiative and seating the combatant via add_combatant in
 * the same gesture. With no combat running, placement alone is the whole
 * action.
 *
 * Phase 4: mounted as the DM's book's "Enemies" page — the book keeps this
 * mounted whenever that page is open regardless of whether a live map
 * exists, so stat blocks can be prepped between maps; `hasLiveMap` gates
 * only the Quick add action (which needs a live grid to click), not the
 * panel's existence.
 *
 * Weather & Enemies C7 adds an "Override model" upload per template row in
 * the library section below, reusing AssetPalette.tsx's/DiceTrayPicker.tsx's
 * exact upload pipeline (validateGlbFile → ModelOrientationStep's
 * rotate-and-confirm step → uploadMapAssetFile/createCustomAsset →
 * setForwardOffsetDeg) — no parallel upload mechanism. The upload itself
 * happens right here (this component owns it, the DiceTrayPicker
 * precedent); once the new custom asset_library row exists, `onUploadOverride`
 * hands it up to GameRoom, which links it as that template's override
 * (campaign_monster_template_overrides, 0075) and appends it to the
 * caller's own asset list. Scoped to THIS campaign only — a DM here can
 * never affect how the same template renders anywhere else.
 */
export function MonsterPanel({
  statBlocks,
  templates,
  rosterNpcs,
  combatActive,
  hasLiveMap,
  busy,
  error,
  onCreate,
  onUpdate,
  onDelete,
  onQuickAdd,
  onAddFromTemplate,
  campaignId,
  templateOverrides,
  overrideBusy,
  overrideError,
  onUploadOverride,
  onRemoveOverride,
}: {
  statBlocks: MonsterStatBlock[];
  /** Weather & Enemies C5: the GLOBAL monster template library (0073) —
   * "Add to campaign" copies one into a brand new row in statBlocks above
   * (a one-time value copy, never a live link back to this list). */
  templates: MonsterTemplate[];
  /** The Prompt 33 narrative roster, for the name pre-fill convenience. */
  rosterNpcs: Npc[];
  combatActive: boolean;
  /** Gates Quick add only (its own doc comment above) — false between maps
   * or before one has ever gone live. */
  hasLiveMap: boolean;
  busy: boolean;
  error: string | null;
  onCreate: (params: {
    name: string;
    maxHp: number;
    armorClass: number;
    passivePerception: number;
    attacks: MonsterAttack[];
  }) => void;
  onUpdate: (
    statBlockId: string,
    patch: {
      name: string;
      max_hp: number;
      armor_class: number;
      passive_perception: number;
      attacks: MonsterAttack[];
    }
  ) => void;
  onDelete: (statBlock: MonsterStatBlock) => void;
  /** Arms grid-click placement for this block's token (GameRoom). */
  onQuickAdd: (statBlock: MonsterStatBlock) => void;
  /** Copies a template's stats into a brand new stat block above — never
   * mutates the template itself. */
  onAddFromTemplate: (template: MonsterTemplate) => void;
  /** Weather & Enemies C7: needed by this panel's own override-upload flow
   * (uploadMapAssetFile scopes every custom asset to a campaign_id). */
  campaignId: string;
  /** This campaign's own override, if any, for each template — id-keyed by
   * monster_template_id (GameRoom's overrideDisplayByTemplateId). Absent
   * for a template with no override set: it still renders C6's own
   * default_asset_id model, unaffected. */
  templateOverrides: Map<string, { assetId: string; assetName: string }>;
  /** True while a set/remove-override write is in flight — the SEPARATE
   * busy flag from `busy` above (stat-block CRUD), since an override
   * upload/link/removal is its own concern. */
  overrideBusy: boolean;
  overrideError: string | null;
  /** Fires once THIS component's own upload has already created the new
   * custom asset_library row — GameRoom links it as `templateId`'s override
   * and appends it to the campaign's asset list. */
  onUploadOverride: (templateId: string, asset: PaletteAsset) => void;
  /** Reverts `templateId`'s rendering in this campaign back to C6's own
   * default_asset_id. */
  onRemoveOverride: (templateId: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [maxHp, setMaxHp] = useState("");
  const [armorClass, setArmorClass] = useState("");
  const [passivePerception, setPassivePerception] = useState("10");
  const [attackDrafts, setAttackDrafts] = useState<AttackDraft[]>([{ ...EMPTY_ATTACK }]);
  const [rosterPick, setRosterPick] = useState("");

  // Weather & Enemies C7: the per-template override upload flow — one
  // shared hidden file input and pending-orientation-step slot (like
  // AssetPalette's own single `pendingFile`), tracking WHICH template it's
  // currently uploading for via `overrideUploadTargetId` rather than one
  // input/ref per template row.
  const [overrideUploadTargetId, setOverrideUploadTargetId] = useState<string | null>(null);
  const [overrideUploadBusy, setOverrideUploadBusy] = useState(false);
  const [overrideUploadError, setOverrideUploadError] = useState<string | null>(null);
  const [pendingOverrideFile, setPendingOverrideFile] = useState<File | null>(null);
  const overrideFileInputRef = useRef<HTMLInputElement>(null);

  function startOverrideUpload(templateId: string) {
    setOverrideUploadTargetId(templateId);
    setOverrideUploadError(null);
    overrideFileInputRef.current?.click();
  }

  async function handleOverrideFileChosen(fileList: FileList | null) {
    const file = fileList?.[0];
    const templateId = overrideUploadTargetId;
    if (!file || !templateId) return;
    setOverrideUploadError(null);
    setOverrideUploadBusy(true);
    const result = await validateGlbFile(file, "monster override models");
    if (!result.ok) {
      setOverrideUploadError(result.message);
      setOverrideUploadBusy(false);
      setOverrideUploadTargetId(null);
      if (overrideFileInputRef.current) overrideFileInputRef.current.value = "";
      return;
    }
    // Hands off to the rotate-and-confirm step, same as AssetPalette's own
    // upload — completeOverrideUpload runs once the uploader skips or
    // confirms a forward-direction offset.
    setPendingOverrideFile(file);
  }

  async function completeOverrideUpload(forwardOffsetDeg: number) {
    const file = pendingOverrideFile;
    const templateId = overrideUploadTargetId;
    const template = templateId ? templates.find((candidate) => candidate.id === templateId) : undefined;
    setPendingOverrideFile(null);
    if (!file || !templateId || !template) {
      setOverrideUploadBusy(false);
      setOverrideUploadTargetId(null);
      return;
    }
    try {
      const supabase = createBrowserSupabaseClient();
      const path = await uploadMapAssetFile(supabase, campaignId, file);
      const asset = await createCustomAsset(supabase, {
        campaignId,
        name: `${template.name} (custom)`,
        modelRef: path,
      });
      await setForwardOffsetDeg(supabase, path, forwardOffsetDeg);
      const url = await getMapAssetSignedUrl(supabase, path, 6 * 60 * 60).catch(() => null);
      // The upload/catalog half is done — GameRoom takes it from here
      // (appends to the campaign's own asset list, links it as this
      // template's override).
      onUploadOverride(templateId, { ...asset, url, forwardOffsetDeg });
    } catch {
      setOverrideUploadError("Couldn't upload that override model — try again.");
    } finally {
      setOverrideUploadBusy(false);
      setOverrideUploadTargetId(null);
      if (overrideFileInputRef.current) overrideFileInputRef.current.value = "";
    }
  }

  function resetForm() {
    setEditingId(null);
    setName("");
    setMaxHp("");
    setArmorClass("");
    setPassivePerception("10");
    setAttackDrafts([{ ...EMPTY_ATTACK }]);
    setRosterPick("");
  }

  function loadForEdit(statBlock: MonsterStatBlock) {
    setEditingId(statBlock.id);
    setName(statBlock.name);
    setMaxHp(String(statBlock.max_hp));
    setArmorClass(String(statBlock.armor_class));
    setPassivePerception(String(statBlock.passive_perception));
    setAttackDrafts(
      statBlock.attacks.length > 0
        ? statBlock.attacks.map((attack) => ({
            name: attack.name,
            bonus: String(attack.bonus),
            damageNotation: attack.damageNotation,
          }))
        : [{ ...EMPTY_ATTACK }]
    );
  }

  function positiveInt(raw: string): number | null {
    const value = Number(raw.trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  /** Parsed attacks, or null while any partially-filled row is invalid.
   * Fully-empty rows are simply dropped — a block with no attacks is
   * legal (it can still be placed, fought, hidden from). */
  function parsedAttacks(): MonsterAttack[] | null {
    const attacks: MonsterAttack[] = [];
    for (const draft of attackDrafts) {
      const empty =
        draft.name.trim() === "" && draft.bonus.trim() === "" && draft.damageNotation.trim() === "";
      if (empty) continue;
      const bonus = Number(draft.bonus.trim());
      if (draft.name.trim() === "" || !Number.isInteger(bonus) || draft.damageNotation.trim() === "") {
        return null;
      }
      attacks.push({
        name: draft.name.trim(),
        bonus,
        damageNotation: draft.damageNotation.trim(),
      });
    }
    return attacks;
  }

  const parsedHp = positiveInt(maxHp);
  const parsedAc = positiveInt(armorClass);
  const parsedPp = positiveInt(passivePerception);
  const attacks = parsedAttacks();
  const canSave =
    !busy && name.trim() !== "" && parsedHp !== null && parsedAc !== null && parsedPp !== null && attacks !== null;

  function save() {
    if (!canSave || parsedHp === null || parsedAc === null || parsedPp === null || attacks === null) {
      return;
    }
    if (editingId) {
      onUpdate(editingId, {
        name: name.trim(),
        max_hp: parsedHp,
        armor_class: parsedAc,
        passive_perception: parsedPp,
        attacks,
      });
    } else {
      onCreate({
        name: name.trim(),
        maxHp: parsedHp,
        armorClass: parsedAc,
        passivePerception: parsedPp,
        attacks,
      });
    }
    resetForm();
  }

  return (
    <aside className={styles.monsterPanel} data-testid="monster-panel">
      <div className={styles.objectHeader}>
        <span className={styles.panelLabel}>Monsters</span>
        <Badge tone="red">DM only</Badge>
      </div>

      {statBlocks.length === 0 ? (
        <p className={styles.hint}>No stat blocks yet — stat one up below.</p>
      ) : (
        <div className={styles.tokenSection}>
          {statBlocks.map((statBlock) => (
            <div
              key={statBlock.id}
              className={styles.objectRow}
              data-testid={`stat-block-${statBlock.id}`}
            >
              <div className={styles.objectHeader}>
                <span className={styles.objectName}>{statBlock.name}</span>
                <Badge tone={ALLEGIANCE_TONE[statBlock.default_allegiance]}>
                  {statBlock.default_allegiance}
                </Badge>
                <span className={styles.quickActionMeta}>
                  HP {statBlock.max_hp} · AC {statBlock.armor_class} · PP{" "}
                  {statBlock.passive_perception}
                </span>
              </div>
              {statBlock.attacks.length > 0 ? (
                <span className={styles.quickActionMeta}>{formatAttackSummary(statBlock.attacks)}</span>
              ) : null}
              <div className={styles.objectHeader}>
                <Button
                  size="sm"
                  variant="accent"
                  disabled={busy || !hasLiveMap}
                  onClick={() => onQuickAdd(statBlock)}
                  data-testid={`quick-add-${statBlock.id}`}
                  title={hasLiveMap ? undefined : "Switch to a live map to place tokens"}
                >
                  Quick add
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => loadForEdit(statBlock)}
                  data-testid={`edit-stat-block-${statBlock.id}`}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => onDelete(statBlock)}
                  data-testid={`delete-stat-block-${statBlock.id}`}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className={styles.hint} data-testid="monster-panel-quick-add-hint">
        {hasLiveMap
          ? `Quick add places the token by grid click${
              combatActive ? ", then asks for its initiative to join the fight" : ""
            }.`
          : "Stat blocks can be prepped here between maps — Quick add needs a live map to place tokens."}
      </p>

      {/* Weather & Enemies C5: browse the shared, GLOBAL template library
          (monster_templates, 0073) and copy one into THIS campaign's own
          stat blocks above — a one-time, independent value copy, never a
          live link. The template itself is never mutated by this action
          (0073's RLS wouldn't allow it from here anyway: writes are
          app-admin-only). The freshly copied row then behaves exactly
          like any hand-authored stat block — its own ordinary Quick add
          button, freely editable, deletable without touching the source
          template. */}
      <div className={styles.tokenSection} data-testid="monster-template-library">
        <span className={styles.diceSectionLabel}>Add from library</span>
        {templates.length === 0 ? (
          <p className={styles.hint}>No templates available.</p>
        ) : (
          templates.map((template) => {
            // Weather & Enemies C7: THIS campaign's own override, if any —
            // absent means the template still renders C6's own
            // default_asset_id model, unaffected by any other campaign's
            // override.
            const override = templateOverrides.get(template.id);
            return (
              <div
                key={template.id}
                className={styles.objectRow}
                data-testid={`monster-template-${template.id}`}
              >
                <div className={styles.objectHeader}>
                  <span className={styles.objectName}>{template.name}</span>
                  <Badge tone={ALLEGIANCE_TONE[template.default_allegiance]}>
                    {template.default_allegiance}
                  </Badge>
                  <span className={styles.quickActionMeta}>
                    HP {template.max_hp} · AC {template.armor_class} · PP {template.passive_perception}
                  </span>
                </div>
                {template.description ? <p className={styles.hint}>{template.description}</p> : null}
                {template.attacks.length > 0 ? (
                  <span className={styles.quickActionMeta}>{formatAttackSummary(template.attacks)}</span>
                ) : null}
                <div className={styles.objectHeader}>
                  <Button
                    size="sm"
                    variant="accent"
                    disabled={busy}
                    onClick={() => onAddFromTemplate(template)}
                    data-testid={`add-template-${template.id}`}
                  >
                    Add to campaign
                  </Button>
                </div>
                {/* Weather & Enemies C7: per-campaign appearance override —
                    scoped to THIS campaign only (0075's own RLS/write
                    path); a different campaign using this same template
                    keeps rendering C6's default model regardless. */}
                <div className={styles.objectHeader}>
                  {override ? (
                    <>
                      <span
                        className={styles.quickActionMeta}
                        data-testid={`template-override-current-${template.id}`}
                      >
                        Custom model: {override.assetName}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={overrideBusy}
                        onClick={() => onRemoveOverride(template.id)}
                        data-testid={`remove-override-${template.id}`}
                      >
                        Remove override
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={overrideBusy || overrideUploadBusy}
                      onClick={() => startOverrideUpload(template.id)}
                      data-testid={`upload-override-${template.id}`}
                    >
                      {overrideUploadBusy && overrideUploadTargetId === template.id
                        ? "Uploading…"
                        : "Upload override model"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
        <input
          ref={overrideFileInputRef}
          type="file"
          accept=".glb,model/gltf-binary"
          aria-label="Upload a custom monster override model"
          className={styles.hiddenFileInput}
          disabled={overrideUploadBusy}
          onChange={(event) => void handleOverrideFileChosen(event.target.files)}
        />
        <p className={styles.hint}>Override models: binary glTF (.glb), max 10MB.</p>
        {overrideUploadError ? (
          <p role="alert" className={styles.errorText} data-testid="monster-template-override-upload-error">
            {overrideUploadError}
          </p>
        ) : null}
        {overrideError ? (
          <p role="alert" className={styles.errorText} data-testid="monster-template-override-error">
            {overrideError}
          </p>
        ) : null}
        {pendingOverrideFile ? (
          <ModelOrientationStep
            file={pendingOverrideFile}
            normalize={{ kind: "maxDimension", targetSize: PLACED_OBJECT_SIZE }}
            onDone={(forwardOffsetDeg) => void completeOverrideUpload(forwardOffsetDeg)}
          />
        ) : null}
      </div>

      <div className={styles.tokenSection} data-testid="stat-block-form">
        <span className={styles.diceSectionLabel}>
          {editingId ? "Edit stat block" : "New stat block"}
        </span>
        {rosterNpcs.length > 0 && !editingId ? (
          // The Prompt 33 promote convenience: pre-fill the name from a
          // roster NPC instead of re-typing it. A pre-fill only, on
          // purpose — the roster row is untouched.
          <select
            className={styles.diceSelect}
            aria-label="Start from roster NPC"
            value={rosterPick}
            onChange={(event) => {
              setRosterPick(event.target.value);
              const npc = rosterNpcs.find((candidate) => candidate.id === event.target.value);
              if (npc) setName(npc.name);
            }}
            data-testid="stat-block-roster-select"
          >
            <option value="">Start from roster NPC…</option>
            {rosterNpcs.map((npc) => (
              <option key={npc.id} value={npc.id}>
                {npc.name}
              </option>
            ))}
          </select>
        ) : null}
        <div className={styles.objectHeader}>
          <input
            className={styles.initiativeInput}
            placeholder="Name"
            aria-label="Stat block name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid="stat-block-name-input"
          />
          <input
            className={styles.initiativeInput}
            type="number"
            min={1}
            placeholder="HP"
            aria-label="Maximum HP"
            value={maxHp}
            onChange={(event) => setMaxHp(event.target.value)}
            data-testid="stat-block-hp-input"
          />
          <input
            className={styles.initiativeInput}
            type="number"
            min={1}
            max={99}
            placeholder="AC"
            aria-label="Armor class"
            value={armorClass}
            onChange={(event) => setArmorClass(event.target.value)}
            data-testid="stat-block-ac-input"
          />
          <input
            className={styles.initiativeInput}
            type="number"
            min={1}
            placeholder="PP"
            aria-label="Passive Perception"
            value={passivePerception}
            onChange={(event) => setPassivePerception(event.target.value)}
            data-testid="stat-block-pp-input"
          />
        </div>
        {attackDrafts.map((draft, index) => (
          <div className={styles.objectHeader} key={index}>
            <input
              className={styles.initiativeInput}
              placeholder="Attack name"
              aria-label={`Attack ${index + 1} name`}
              value={draft.name}
              onChange={(event) =>
                setAttackDrafts((drafts) =>
                  drafts.map((row, i) => (i === index ? { ...row, name: event.target.value } : row))
                )
              }
              data-testid={`stat-block-attack-name-${index}`}
            />
            <input
              className={styles.initiativeInput}
              type="number"
              placeholder="Bonus"
              aria-label={`Attack ${index + 1} bonus`}
              value={draft.bonus}
              onChange={(event) =>
                setAttackDrafts((drafts) =>
                  drafts.map((row, i) => (i === index ? { ...row, bonus: event.target.value } : row))
                )
              }
              data-testid={`stat-block-attack-bonus-${index}`}
            />
            <input
              className={styles.initiativeInput}
              placeholder="1d6+2"
              aria-label={`Attack ${index + 1} damage`}
              value={draft.damageNotation}
              onChange={(event) =>
                setAttackDrafts((drafts) =>
                  drafts.map((row, i) =>
                    i === index ? { ...row, damageNotation: event.target.value } : row
                  )
                )
              }
              data-testid={`stat-block-attack-damage-${index}`}
            />
            {attackDrafts.length > 1 ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setAttackDrafts((drafts) => drafts.filter((_, i) => i !== index))}
                aria-label={`Remove attack ${index + 1}`}
                data-testid={`stat-block-attack-remove-${index}`}
              >
                −
              </Button>
            ) : null}
          </div>
        ))}
        <div className={styles.objectHeader}>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setAttackDrafts((drafts) => [...drafts, { ...EMPTY_ATTACK }])}
            data-testid="stat-block-attack-add"
          >
            + Attack
          </Button>
          <Button
            size="sm"
            variant="accent"
            disabled={!canSave}
            onClick={save}
            data-testid="stat-block-save"
          >
            {editingId ? "Save changes" : "Create stat block"}
          </Button>
          {editingId ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={resetForm}
              data-testid="stat-block-cancel-edit"
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p role="alert" className={styles.errorText} data-testid="monster-panel-error">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
