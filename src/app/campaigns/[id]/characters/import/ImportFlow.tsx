"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  CLASSES,
  RACE_OPTION_NAMES,
  SKILLS,
  SPELLS,
  abilityModifier,
  resolveRaceOption,
  savingThrowBonus,
  skillCheckBonus,
  type AbilityScore,
  type AbilityScores,
  type SkillName,
} from "@/rules-engine";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { createCharacter, type InventoryItem, type KnownSpell } from "@/data-access";
import { Badge, Button, Panel, SectionHeader, Select, TextInput } from "@/ui-components";
import type { CharacterDraft, ImportResult } from "./lib/types";
import sheetStyles from "../[characterId]/sheet.module.css";
import wizardStyles from "../new/wizard.module.css";
import styles from "./import.module.css";

const ABILITIES: AbilityScore[] = [
  "strength",
  "dexterity",
  "constitution",
  "intelligence",
  "wisdom",
  "charisma",
];

const ABILITY_LABEL: Record<AbilityScore, string> = {
  strength: "Strength",
  dexterity: "Dexterity",
  constitution: "Constitution",
  intelligence: "Intelligence",
  wisdom: "Wisdom",
  charisma: "Charisma",
};

function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

function parseIntIn(raw: string, min: number, max: number): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

type Stage = "upload" | "loading" | "error" | "review";

export function ImportFlow({
  campaignId,
  campaignName,
  userId,
}: {
  campaignId: string;
  campaignName: string;
  userId: string;
}) {
  const router = useRouter();

  const [stage, setStage] = useState<Stage>("upload");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [raceName, setRaceName] = useState("");
  const [className, setClassName] = useState("");
  const [level, setLevel] = useState("1");
  const [scores, setScores] = useState<Record<AbilityScore, string>>(() =>
    Object.fromEntries(ABILITIES.map((a) => [a, "10"])) as Record<AbilityScore, string>
  );
  const [maxHp, setMaxHp] = useState("10");
  const [armorClass, setArmorClass] = useState("10");
  const [speed, setSpeed] = useState("30");
  const [proficiencies, setProficiencies] = useState<string[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [spells, setSpells] = useState<KnownSpell[]>([]);
  const [newItemName, setNewItemName] = useState("");
  const [newItemQty, setNewItemQty] = useState("1");
  const [spellToAdd, setSpellToAdd] = useState("");

  const klass = CLASSES.find((c) => c.name === className) ?? null;
  const isCaster = Boolean(klass?.spellcastingAbility);
  const parsedLevel = parseIntIn(level, 1, 20) ?? 1;
  const parsedScores: AbilityScores = Object.fromEntries(
    ABILITIES.map((a) => [a, parseIntIn(scores[a], 1, 30) ?? 10])
  ) as AbilityScores;

  function loadDraft(draft: CharacterDraft) {
    setName(draft.name);
    setRaceName(draft.race ?? "");
    setClassName(draft.class ?? "");
    setLevel(String(draft.level));
    setScores(
      Object.fromEntries(ABILITIES.map((a) => [a, String(draft.abilityScores[a])])) as Record<
        AbilityScore,
        string
      >
    );
    setMaxHp(String(draft.maxHp));
    setArmorClass(String(draft.armorClass));
    setSpeed(String(draft.speed));
    setProficiencies(draft.proficiencies);
    setInventory(draft.inventory);
    setSpells(draft.spells);
    setWarnings(draft.warnings);
  }

  async function handleFileChosen(file: File) {
    setStage("loading");
    setErrorMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/campaigns/${campaignId}/characters/import/parse`, {
        method: "POST",
        body: formData,
      });
      const result = (await res.json()) as ImportResult;
      if (!result.ok) {
        setErrorMessage(result.message);
        setStage("error");
        return;
      }
      loadDraft(result.draft);
      setStage("review");
    } catch {
      setErrorMessage("Something went wrong uploading that file — check your connection and try again.");
      setStage("error");
    }
  }

  function skillProficient(skill: SkillName): boolean {
    return proficiencies.includes(skill);
  }
  function saveProficient(ability: AbilityScore): boolean {
    return proficiencies.includes(`${ABILITY_LABEL[ability]} Saving Throws`);
  }
  function toggleSkill(skill: SkillName) {
    setProficiencies((p) => (p.includes(skill) ? p.filter((x) => x !== skill) : [...p, skill]));
  }
  function toggleSave(ability: AbilityScore) {
    const key = `${ABILITY_LABEL[ability]} Saving Throws`;
    setProficiencies((p) => (p.includes(key) ? p.filter((x) => x !== key) : [...p, key]));
  }

  function addItem() {
    const trimmed = newItemName.trim();
    const quantity = parseIntIn(newItemQty, 1, 9999);
    if (!trimmed || quantity === null) return;
    setInventory((items) => [...items, { name: trimmed, quantity }]);
    setNewItemName("");
    setNewItemQty("1");
  }
  function adjustItemQuantity(index: number, delta: number) {
    setInventory((items) =>
      items.map((item, i) => (i === index ? { ...item, quantity: Math.max(1, item.quantity + delta) } : item))
    );
  }
  function removeItem(index: number) {
    setInventory((items) => items.filter((_, i) => i !== index));
  }

  function addSpell() {
    const spell = SPELLS.find((s) => s.name === spellToAdd);
    if (!spell || spells.some((s) => s.name === spell.name)) return;
    setSpells((current) =>
      [...current, { name: spell.name, level: spell.level }].sort(
        (a, b) => a.level - b.level || a.name.localeCompare(b.name)
      )
    );
    setSpellToAdd("");
  }
  function removeSpell(spellName: string) {
    setSpells((current) => current.filter((s) => s.name !== spellName));
  }

  async function handleConfirm() {
    setSaving(true);
    setSaveError(null);
    const supabase = createBrowserSupabaseClient();
    try {
      await createCharacter(supabase, {
        campaign_id: campaignId,
        owner_id: userId,
        name: name.trim() || "Imported Character",
        race: raceName || "Unknown",
        class: className || "Unknown",
        // The import flow has no source data for a subclass pick — like
        // fresh character creation, that's the level-up wizard's job once
        // the imported character next levels up past its class's gate.
        subclass: null,
        level: parsedLevel,
        ...parsedScores,
        current_hp: parseIntIn(maxHp, 0, 999) ?? 10,
        max_hp: parseIntIn(maxHp, 1, 999) ?? 10,
        armor_class: parseIntIn(armorClass, 0, 40) ?? 10,
        speed: parseIntIn(speed, 0, 300) ?? 30,
        // D&D Beyond PDFs don't carry darkvision as a parsed field, so it
        // derives from the reviewed race pick via the shared rules-engine
        // resolver; an unknown race means normal vision.
        darkvision_feet: resolveRaceOption(raceName)?.darkvisionFeet ?? null,
        proficiencies,
        inventory,
        spells,
      });
      router.push(`/campaigns/${campaignId}`);
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not create the character.");
      setSaving(false);
    }
  }

  const addableSpells = SPELLS.filter((spell) => !spells.some((s) => s.name === spell.name)).sort(
    (a, b) => a.level - b.level || a.name.localeCompare(b.name)
  );

  return (
    <div className={sheetStyles.page}>
      <main className={sheetStyles.main}>
        <Link href={`/campaigns/${campaignId}`} className={sheetStyles.backLink}>
          ← Back to {campaignName}
        </Link>

        <SectionHeader eyebrow="Import a character" title="Import from D&D Beyond" as="h1" />

        {stage === "upload" || stage === "error" ? (
          <Panel tone="purple">
            <div className={styles.uploadBody}>
              <p className={wizardStyles.detailText}>
                Upload a character sheet PDF exported from D&D Beyond. We&apos;ll read it and build a
                draft you can review and edit — nothing is saved until you confirm.
              </p>
              {errorMessage ? (
                <p className={sheetStyles.saveError} role="alert">
                  {errorMessage}
                </p>
              ) : null}
              <input
                type="file"
                accept="application/pdf,.pdf"
                className={styles.fileInput}
                aria-label="D&D Beyond character sheet PDF"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileChosen(file);
                  e.target.value = "";
                }}
              />
            </div>
          </Panel>
        ) : null}

        {stage === "loading" ? (
          <Panel tone="teal">
            <p className={wizardStyles.detailText}>Reading your character sheet — this can take a few seconds…</p>
          </Panel>
        ) : null}

        {stage === "review" ? (
          <>
            {warnings.length > 0 ? (
              <Panel title="Check these before saving" tone="pink">
                <ul className={styles.warningList}>
                  {warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            <Panel title="Identity" tone="purple">
              <div className={styles.identityGrid}>
                <TextInput label="Character name" value={name} onChange={(e) => setName(e.target.value)} required />
                <Select label="Race" value={raceName} onChange={(e) => setRaceName(e.target.value)}>
                  <option value="">Choose a race…</option>
                  {RACE_OPTION_NAMES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
                <Select label="Class" value={className} onChange={(e) => setClassName(e.target.value)}>
                  <option value="">Choose a class…</option>
                  {CLASSES.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </Select>
                <TextInput
                  label="Level"
                  type="number"
                  min={1}
                  max={20}
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                />
              </div>
            </Panel>

            <Panel title="Vitals" tone="purple">
              <div className={sheetStyles.vitalsGrid}>
                <div className={sheetStyles.vital}>
                  <span className={sheetStyles.vitalLabel}>Max HP</span>
                  <input
                    className={sheetStyles.vitalInput}
                    type="number"
                    min={1}
                    value={maxHp}
                    onChange={(e) => setMaxHp(e.target.value)}
                    aria-label="Max hit points"
                  />
                </div>
                <div className={sheetStyles.vital}>
                  <span className={sheetStyles.vitalLabel}>Armor class</span>
                  <input
                    className={sheetStyles.vitalInput}
                    type="number"
                    min={0}
                    max={40}
                    value={armorClass}
                    onChange={(e) => setArmorClass(e.target.value)}
                    aria-label="Armor class"
                  />
                </div>
                <div className={sheetStyles.vital}>
                  <span className={sheetStyles.vitalLabel}>Speed</span>
                  <input
                    className={sheetStyles.vitalInput}
                    type="number"
                    min={0}
                    value={speed}
                    onChange={(e) => setSpeed(e.target.value)}
                    aria-label="Speed in feet"
                  />
                </div>
              </div>
            </Panel>

            <Panel title="Abilities & Saves" tone="teal">
              <div className={sheetStyles.abilityGrid}>
                {ABILITIES.map((ability) => (
                  <div key={ability} className={sheetStyles.abilityCard}>
                    <span className={sheetStyles.vitalLabel}>{ABILITY_LABEL[ability]}</span>
                    <input
                      className={sheetStyles.vitalInput}
                      type="number"
                      min={1}
                      max={30}
                      value={scores[ability]}
                      onChange={(e) => setScores((s) => ({ ...s, [ability]: e.target.value }))}
                      aria-label={`${ABILITY_LABEL[ability]} score`}
                    />
                    <span className={sheetStyles.abilityModifier}>
                      {formatModifier(abilityModifier(parsedScores[ability]))}
                    </span>
                    <label className={sheetStyles.abilitySave}>
                      <input
                        type="checkbox"
                        checked={saveProficient(ability)}
                        onChange={() => toggleSave(ability)}
                      />
                      Save {formatModifier(savingThrowBonus(ability, parsedScores, parsedLevel, saveProficient(ability)))}
                    </label>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel title="Skills" tone="purple">
              <ul className={sheetStyles.rowList}>
                {SKILLS.map((skill) => (
                  <li key={skill.name} className={sheetStyles.skillRow}>
                    <label className={sheetStyles.skillToggle}>
                      <input
                        type="checkbox"
                        className={sheetStyles.skillCheckbox}
                        checked={skillProficient(skill.name)}
                        onChange={() => toggleSkill(skill.name)}
                      />
                      <span>{skill.name}</span>
                      <span className={sheetStyles.skillAbility}>{ABILITY_LABEL[skill.ability].slice(0, 3)}</span>
                    </label>
                    <span className={sheetStyles.skillBonus}>
                      {formatModifier(
                        skillCheckBonus(skill.name, parsedScores, parsedLevel, skillProficient(skill.name))
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel title="Inventory" tone="pink">
              {inventory.length === 0 ? (
                <p className={sheetStyles.emptyHint}>Nothing carried yet.</p>
              ) : (
                <ul className={sheetStyles.rowList}>
                  {inventory.map((item, index) => (
                    <li key={`${item.name}-${index}`} className={sheetStyles.itemRow}>
                      <span className={sheetStyles.itemName}>{item.name}</span>
                      <span className={sheetStyles.itemControls}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => adjustItemQuantity(index, -1)}
                          disabled={item.quantity <= 1}
                          aria-label={`Remove one ${item.name}`}
                        >
                          −
                        </Button>
                        <span className={sheetStyles.itemQty}>×{item.quantity}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => adjustItemQuantity(index, 1)}
                          aria-label={`Add one ${item.name}`}
                        >
                          +
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => removeItem(index)}
                          aria-label={`Drop ${item.name}`}
                        >
                          Drop
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className={sheetStyles.addRow}>
                <TextInput
                  label="Item"
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  placeholder="e.g. Rope (50 ft)"
                  className={sheetStyles.addName}
                />
                <TextInput
                  label="Qty"
                  type="number"
                  min={1}
                  value={newItemQty}
                  onChange={(e) => setNewItemQty(e.target.value)}
                  className={sheetStyles.addQty}
                />
                <Button
                  variant="teal"
                  onClick={addItem}
                  disabled={!newItemName.trim() || parseIntIn(newItemQty, 1, 9999) === null}
                >
                  Add item
                </Button>
              </div>
            </Panel>

            {isCaster ? (
              <Panel title="Spells" tone="purple">
                {spells.length === 0 ? (
                  <p className={sheetStyles.emptyHint}>No spells known yet.</p>
                ) : (
                  <ul className={sheetStyles.rowList}>
                    {spells.map((known) => (
                      <li key={known.name} className={sheetStyles.itemRow}>
                        <span className={sheetStyles.itemName}>
                          {known.name} <Badge tone="neutral">{known.level === 0 ? "cantrip" : `lvl ${known.level}`}</Badge>
                        </span>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => removeSpell(known.name)}
                          aria-label={`Forget ${known.name}`}
                        >
                          Forget
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className={sheetStyles.addRow}>
                  <Select
                    label="Add a spell"
                    value={spellToAdd}
                    onChange={(e) => setSpellToAdd(e.target.value)}
                    className={sheetStyles.addName}
                  >
                    <option value="">Choose a spell…</option>
                    {addableSpells.map((spell) => (
                      <option key={spell.name} value={spell.name}>
                        {spell.name} ({spell.level === 0 ? "cantrip" : `level ${spell.level}`})
                      </option>
                    ))}
                  </Select>
                  <Button variant="teal" onClick={addSpell} disabled={!spellToAdd}>
                    Learn spell
                  </Button>
                </div>
              </Panel>
            ) : null}

            {saveError ? (
              <p className={sheetStyles.saveError} role="alert">
                {saveError}
              </p>
            ) : null}

            <div className={wizardStyles.footerNav}>
              <Button variant="ghost" onClick={() => setStage("upload")} disabled={saving}>
                Start over
              </Button>
              <Button onClick={handleConfirm} disabled={saving || !name.trim()}>
                {saving ? "Creating…" : "Create character"}
              </Button>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
