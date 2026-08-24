"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CLASSES,
  SKILLS,
  SPELLS,
  abilityModifier,
  proficiencyBonus,
  savingThrowBonus,
  skillCheckBonus,
  passiveScore,
  type AbilityScore,
  type AbilityScores,
  type SkillName,
  type SpellRange,
} from "@/rules-engine";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import {
  updateCharacter,
  setCharacterResourceUses,
  type Character,
  type CharacterResource,
  type InventoryItem,
  type KnownSpell,
  type UpdateCharacterPatch,
} from "@/data-access";
import { Badge, Button, Panel, SectionHeader, Select, TextInput } from "@/ui-components";
import styles from "./sheet.module.css";

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

const RECHARGE_LABEL: Record<CharacterResource["recharge"], string> = {
  short_rest: "Short rest",
  long_rest: "Long rest",
  daily: "Daily",
};

function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

function formatRange(range: SpellRange): string {
  return typeof range === "number" ? `${range} ft` : range;
}

function spellLevelLabel(level: number): string {
  if (level === 0) return "Cantrips";
  const ordinal = ["1st", "2nd", "3rd"][level - 1] ?? `${level}th`;
  return `${ordinal}-level spells`;
}

function parseIntIn(raw: string, min: number, max: number): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export function CharacterSheet({
  campaignId,
  initialCharacter,
  initialResources,
  canEdit,
}: {
  campaignId: string;
  initialCharacter: Character;
  initialResources: CharacterResource[];
  canEdit: boolean;
}) {
  const [character, setCharacter] = useState(initialCharacter);
  const [resources, setResources] = useState(initialResources);
  const [scoreDrafts, setScoreDrafts] = useState<Record<AbilityScore, string>>(() =>
    Object.fromEntries(ABILITIES.map((a) => [a, String(initialCharacter[a])])) as Record<
      AbilityScore,
      string
    >
  );
  const [hpDraft, setHpDraft] = useState(String(initialCharacter.current_hp));
  const [acDraft, setAcDraft] = useState(String(initialCharacter.armor_class));
  const [newItemName, setNewItemName] = useState("");
  const [newItemQty, setNewItemQty] = useState("1");
  const [spellToAdd, setSpellToAdd] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const klass = CLASSES.find((c) => c.name === character.class) ?? null;
  const isCaster = Boolean(klass?.spellcastingAbility);

  // Live scores: a valid in-progress draft drives every derived stat before
  // it's persisted; an invalid draft falls back to the saved value.
  const abilityScores = Object.fromEntries(
    ABILITIES.map((a) => [a, parseIntIn(scoreDrafts[a], 1, 30) ?? character[a]])
  ) as AbilityScores;

  const skillProficient = (skill: SkillName) => character.proficiencies.includes(skill);
  const saveProficient = (ability: AbilityScore) =>
    klass?.savingThrowProficiencies.includes(ability) ?? false;

  // Optimistic: apply the patch locally right away (so toggles and steppers
  // feel instant), reconcile with the server's row, revert on failure.
  async function persist(patch: UpdateCharacterPatch): Promise<boolean> {
    const previous = character;
    setCharacter((c) => ({ ...c, ...patch }));
    setSaveError(null);
    const supabase = createBrowserSupabaseClient();
    try {
      const updated = await updateCharacter(supabase, previous.id, patch);
      setCharacter(updated);
      return true;
    } catch (err) {
      setCharacter(previous);
      setSaveError(err instanceof Error ? err.message : "Could not save the change.");
      return false;
    }
  }

  async function commitScore(ability: AbilityScore) {
    const value = parseIntIn(scoreDrafts[ability], 1, 30);
    if (value === null || value === character[ability]) {
      setScoreDrafts((d) => ({ ...d, [ability]: String(character[ability]) }));
      return;
    }
    const ok = await persist({ [ability]: value });
    if (!ok) setScoreDrafts((d) => ({ ...d, [ability]: String(character[ability]) }));
  }

  async function commitHp() {
    const value = parseIntIn(hpDraft, 0, character.max_hp);
    if (value === null || value === character.current_hp) {
      setHpDraft(String(character.current_hp));
      return;
    }
    const ok = await persist({ current_hp: value });
    if (!ok) setHpDraft(String(character.current_hp));
  }

  async function adjustHp(delta: number) {
    const next = Math.min(Math.max(character.current_hp + delta, 0), character.max_hp);
    if (next === character.current_hp) return;
    setHpDraft(String(next));
    const ok = await persist({ current_hp: next });
    if (!ok) setHpDraft(String(character.current_hp));
  }

  async function commitAc() {
    const value = parseIntIn(acDraft, 0, 40);
    if (value === null || value === character.armor_class) {
      setAcDraft(String(character.armor_class));
      return;
    }
    const ok = await persist({ armor_class: value });
    if (!ok) setAcDraft(String(character.armor_class));
  }

  async function toggleSkill(skill: SkillName) {
    const next = skillProficient(skill)
      ? character.proficiencies.filter((p) => p !== skill)
      : [...character.proficiencies, skill];
    await persist({ proficiencies: next });
  }

  async function addItem() {
    const name = newItemName.trim();
    const quantity = parseIntIn(newItemQty, 1, 999);
    if (!name || quantity === null) return;
    const existing = character.inventory.findIndex((item) => item.name === name);
    const next: InventoryItem[] =
      existing >= 0
        ? character.inventory.map((item, i) =>
            i === existing ? { ...item, quantity: item.quantity + quantity } : item
          )
        : [...character.inventory, { name, quantity }];
    const ok = await persist({ inventory: next });
    if (ok) {
      setNewItemName("");
      setNewItemQty("1");
    }
  }

  async function adjustItemQuantity(index: number, delta: number) {
    const next = character.inventory.map((item, i) =>
      i === index ? { ...item, quantity: Math.max(1, item.quantity + delta) } : item
    );
    await persist({ inventory: next });
  }

  async function removeItem(index: number) {
    await persist({ inventory: character.inventory.filter((_, i) => i !== index) });
  }

  async function addSpell() {
    const spell = SPELLS.find((s) => s.name === spellToAdd);
    if (!spell || character.spells.some((s) => s.name === spell.name)) return;
    const next: KnownSpell[] = [...character.spells, { name: spell.name, level: spell.level }].sort(
      (a, b) => a.level - b.level || a.name.localeCompare(b.name)
    );
    const ok = await persist({ spells: next });
    if (ok) setSpellToAdd("");
  }

  async function removeSpell(name: string) {
    await persist({ spells: character.spells.filter((s) => s.name !== name) });
  }

  async function setResourceUses(resource: CharacterResource, nextUses: number) {
    setSaveError(null);
    const supabase = createBrowserSupabaseClient();
    try {
      const updated = await setCharacterResourceUses(supabase, resource.id, nextUses);
      setResources((rs) => rs.map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not update the resource.");
    }
  }

  const spellLevels = [...new Set(character.spells.map((s) => s.level))].sort((a, b) => a - b);
  const addableSpells = SPELLS.filter(
    (spell) => !character.spells.some((s) => s.name === spell.name)
  ).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
          ← Back to the campaign
        </Link>

        <SectionHeader eyebrow="Character sheet" title={character.name} as="h1" />

        {saveError ? (
          <p className={styles.saveError} role="alert">
            {saveError}
          </p>
        ) : null}

        <Panel
          title="Vitals"
          tone="purple"
          glow
          headerActions={
            <span className={styles.headerBadges}>
              <Badge tone="purple">{character.race}</Badge>
              <Badge tone="teal">
                {character.class} {character.level}
              </Badge>
            </span>
          }
        >
          <div className={styles.vitalsGrid}>
            <div className={styles.vital}>
              <span className={styles.vitalLabel}>Hit points</span>
              {canEdit ? (
                <span className={styles.hpControls}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => adjustHp(-1)}
                    disabled={character.current_hp <= 0}
                    aria-label="Take 1 damage"
                  >
                    −
                  </Button>
                  <input
                    className={styles.vitalInput}
                    type="number"
                    min={0}
                    max={character.max_hp}
                    value={hpDraft}
                    onChange={(e) => setHpDraft(e.target.value)}
                    onBlur={commitHp}
                    aria-label="Current hit points"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => adjustHp(1)}
                    disabled={character.current_hp >= character.max_hp}
                    aria-label="Heal 1 hit point"
                  >
                    +
                  </Button>
                  <span className={styles.vitalMax}>/ {character.max_hp}</span>
                </span>
              ) : (
                <span className={styles.vitalValue}>
                  {character.current_hp} / {character.max_hp}
                </span>
              )}
            </div>
            <div className={styles.vital}>
              <span className={styles.vitalLabel}>Armor class</span>
              {canEdit ? (
                <input
                  className={styles.vitalInput}
                  type="number"
                  min={0}
                  max={40}
                  value={acDraft}
                  onChange={(e) => setAcDraft(e.target.value)}
                  onBlur={commitAc}
                  aria-label="Armor class"
                />
              ) : (
                <span className={styles.vitalValue}>{character.armor_class}</span>
              )}
            </div>
            <div className={styles.vital}>
              <span className={styles.vitalLabel}>Speed</span>
              <span className={styles.vitalValue}>{character.speed} ft</span>
            </div>
            <div className={styles.vital}>
              <span className={styles.vitalLabel}>Proficiency</span>
              <span className={styles.vitalValue}>
                {formatModifier(proficiencyBonus(character.level))}
              </span>
            </div>
          </div>
        </Panel>

        <Panel title="Abilities & Saves" tone="teal">
          <div className={styles.abilityGrid}>
            {ABILITIES.map((ability) => (
              <div key={ability} className={styles.abilityCard}>
                <span className={styles.vitalLabel}>{ABILITY_LABEL[ability]}</span>
                {canEdit ? (
                  <input
                    className={styles.vitalInput}
                    type="number"
                    min={1}
                    max={30}
                    value={scoreDrafts[ability]}
                    onChange={(e) =>
                      setScoreDrafts((d) => ({ ...d, [ability]: e.target.value }))
                    }
                    onBlur={() => commitScore(ability)}
                    aria-label={`${ABILITY_LABEL[ability]} score`}
                  />
                ) : (
                  <span className={styles.vitalValue}>{abilityScores[ability]}</span>
                )}
                <span className={styles.abilityModifier}>
                  {formatModifier(abilityModifier(abilityScores[ability]))}
                </span>
                <span className={styles.abilitySave}>
                  Save{" "}
                  {formatModifier(
                    savingThrowBonus(
                      ability,
                      abilityScores,
                      character.level,
                      saveProficient(ability)
                    )
                  )}
                  {saveProficient(ability) ? <Badge tone="orange">Prof</Badge> : null}
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Skills"
          tone="purple"
          headerActions={
            <Badge tone="teal">
              Passive Perception{" "}
              {passiveScore("Perception", abilityScores, character.level, skillProficient("Perception"))}
            </Badge>
          }
        >
          <ul className={styles.rowList}>
            {SKILLS.map((skill) => (
              <li key={skill.name} className={styles.skillRow}>
                <label className={styles.skillToggle}>
                  <input
                    type="checkbox"
                    className={styles.skillCheckbox}
                    checked={skillProficient(skill.name)}
                    onChange={() => toggleSkill(skill.name)}
                    disabled={!canEdit}
                  />
                  <span>{skill.name}</span>
                  <span className={styles.skillAbility}>
                    {ABILITY_LABEL[skill.ability].slice(0, 3)}
                  </span>
                </label>
                <span className={styles.skillBonus}>
                  {formatModifier(
                    skillCheckBonus(
                      skill.name,
                      abilityScores,
                      character.level,
                      skillProficient(skill.name)
                    )
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Inventory" tone="pink">
          {character.inventory.length === 0 ? (
            <p className={styles.emptyHint}>Nothing carried yet.</p>
          ) : (
            <ul className={styles.rowList}>
              {character.inventory.map((item, index) => (
                <li key={`${item.name}-${index}`} className={styles.itemRow}>
                  <span className={styles.itemName}>{item.name}</span>
                  <span className={styles.itemControls}>
                    {canEdit ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => adjustItemQuantity(index, -1)}
                        disabled={item.quantity <= 1}
                        aria-label={`Remove one ${item.name}`}
                      >
                        −
                      </Button>
                    ) : null}
                    <span className={styles.itemQty}>×{item.quantity}</span>
                    {canEdit ? (
                      <>
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
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canEdit ? (
            <div className={styles.addRow}>
              <TextInput
                label="Item"
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                placeholder="e.g. Rope (50 ft)"
                className={styles.addName}
              />
              <TextInput
                label="Qty"
                type="number"
                min={1}
                value={newItemQty}
                onChange={(e) => setNewItemQty(e.target.value)}
                className={styles.addQty}
              />
              <Button
                variant="teal"
                onClick={addItem}
                disabled={!newItemName.trim() || parseIntIn(newItemQty, 1, 999) === null}
              >
                Add item
              </Button>
            </div>
          ) : null}
        </Panel>

        {isCaster ? (
          <Panel
            title="Spells"
            tone="purple"
            headerActions={
              klass?.spellcastingAbility ? (
                <Badge tone="purple">
                  Spellcasting: {ABILITY_LABEL[klass.spellcastingAbility]}
                </Badge>
              ) : null
            }
          >
            {character.spells.length === 0 ? (
              <p className={styles.emptyHint}>No spells known yet.</p>
            ) : (
              spellLevels.map((level) => (
                <div key={level} className={styles.spellGroup}>
                  <span className={styles.groupLabel}>{spellLevelLabel(level)}</span>
                  <ul className={styles.rowList}>
                    {character.spells
                      .filter((s) => s.level === level)
                      .map((known) => {
                        const spell = SPELLS.find((s) => s.name === known.name);
                        return (
                          <li key={known.name} className={styles.itemRow}>
                            <span className={styles.itemName}>{known.name}</span>
                            <span className={styles.itemControls}>
                              {spell ? (
                                <span className={styles.spellMeta}>
                                  {spell.school} · {formatRange(spell.range)}
                                  {spell.concentration ? " · conc." : ""}
                                </span>
                              ) : null}
                              {canEdit ? (
                                <Button
                                  variant="danger"
                                  size="sm"
                                  onClick={() => removeSpell(known.name)}
                                  aria-label={`Forget ${known.name}`}
                                >
                                  Forget
                                </Button>
                              ) : null}
                            </span>
                          </li>
                        );
                      })}
                  </ul>
                </div>
              ))
            )}
            {canEdit ? (
              <div className={styles.addRow}>
                <Select
                  label="Add a spell"
                  value={spellToAdd}
                  onChange={(e) => setSpellToAdd(e.target.value)}
                  className={styles.addName}
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
            ) : null}
          </Panel>
        ) : null}

        <Panel title="Resources" tone="teal">
          {resources.length === 0 ? (
            <p className={styles.emptyHint}>No limited-use resources tracked.</p>
          ) : (
            <ul className={styles.rowList}>
              {resources.map((resource) => (
                <li key={resource.id} className={styles.itemRow}>
                  <span className={styles.itemName}>
                    {resource.name}{" "}
                    <Badge tone="neutral">{RECHARGE_LABEL[resource.recharge]}</Badge>
                  </span>
                  <span className={styles.itemControls}>
                    <span className={styles.resourceUses}>
                      {resource.current_uses} / {resource.max_uses}
                    </span>
                    {canEdit ? (
                      <>
                        <Button
                          variant="accent"
                          size="sm"
                          onClick={() => setResourceUses(resource, resource.current_uses - 1)}
                          disabled={resource.current_uses <= 0}
                        >
                          Spend
                        </Button>
                        <Button
                          variant="teal"
                          size="sm"
                          onClick={() => setResourceUses(resource, resource.current_uses + 1)}
                          disabled={resource.current_uses >= resource.max_uses}
                        >
                          Restore
                        </Button>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </main>
    </div>
  );
}
