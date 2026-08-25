"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CLASSES,
  CONDITION_BY_KEY,
  EXHAUSTION_KEY,
  EXHAUSTION_LEVEL_DESCRIPTIONS,
  SKILLS,
  SPELLS,
  abilityModifier,
  proficiencyBonus,
  savingThrowBonus,
  skillCheckBonus,
  passiveScore,
  type AbilityScore,
  type AbilityScores,
  type AdvantageMode,
  type ConditionKey,
  type SkillName,
  type SpellRange,
} from "@/rules-engine";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import {
  getActiveCombatantForCharacter,
  listCombatantConditions,
  updateCharacter,
  subscribeToCharacterChanges,
  subscribeToCombatantConditionChanges,
  setCharacterResourceUses,
  shortRest,
  longRest,
  startConcentrating,
  stopConcentrating,
  type Character,
  type CharacterResource,
  type CombatantCondition,
  type InventoryItem,
  type KnownSpell,
  type RollLogEntry,
  type UpdateCharacterPatch,
} from "@/data-access";
import { Badge, Button, Panel, SectionHeader, Select, TextInput } from "@/ui-components";
import { postRoll, type RollRequest } from "../../roll/api";
import { rollDetail, rollHeadline } from "../../roll/format";
import { AdvantageToggle } from "../../room/DiceLogPanel";
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
  initialConditions,
  canEdit,
}: {
  campaignId: string;
  initialCharacter: Character;
  initialResources: CharacterResource[];
  /** Conditions on this character's combatant in the currently active
   * encounter — empty when the character isn't in a fight. */
  initialConditions: CombatantCondition[];
  canEdit: boolean;
}) {
  const [character, setCharacter] = useState(initialCharacter);
  const [resources, setResources] = useState(initialResources);
  const [conditions, setConditions] = useState(initialConditions);
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
  const [rollMode, setRollMode] = useState<AdvantageMode>("normal");
  const [lastRoll, setLastRoll] = useState<RollLogEntry | null>(null);
  const [rolling, setRolling] = useState(false);
  const [rollError, setRollError] = useState<string | null>(null);

  // Mid-combat damage/healing applied from the Game Room (a different page,
  // not connected to any shared realtime channel with this one) must land
  // here live — a postgres_changes subscription on this character's row
  // (see subscribeToCharacterChanges), the same mechanism the room uses for
  // live avatar sync. The ref lets the handler see the latest saved
  // current_hp without resubscribing per change, so the HP draft is only
  // reset when the HP actually moved — not clobbered mid-edit by unrelated
  // sheet saves echoing back.
  const currentHpRef = useRef(character.current_hp);
  useEffect(() => {
    currentHpRef.current = character.current_hp;
  }, [character.current_hp]);
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    return subscribeToCharacterChanges(supabase, initialCharacter.id, (row) => {
      if (row.current_hp !== currentHpRef.current) setHpDraft(String(row.current_hp));
      setCharacter(row);
    });
  }, [initialCharacter.id]);

  // Conditions applied from the Game Room land here live via a
  // postgres_changes poke on combatant_conditions (same page-not-on-the-
  // campaign-channel reasoning as the HP subscription above). Each poke
  // re-resolves the combatant rather than caching it: the row didn't exist
  // yet if combat started after this page loaded. Latest-wins sequencing,
  // same as the room's refreshCombat.
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    let seq = 0;
    return subscribeToCombatantConditionChanges(supabase, () => {
      const current = ++seq;
      void (async () => {
        try {
          const combatant = await getActiveCombatantForCharacter(
            supabase,
            campaignId,
            initialCharacter.id
          );
          const rows = combatant ? await listCombatantConditions(supabase, [combatant.id]) : [];
          if (current === seq) setConditions(rows);
        } catch {
          // A dropped refetch leaves the previous badges in place; the next
          // poke retries.
        }
      })();
    });
  }, [campaignId, initialCharacter.id]);

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

  // Both plain owner-or-DM RLS writes (startConcentrating/stopConcentrating
  // in data-access) — no optimistic step: the returned row is the whole
  // update, and the sheet's postgres_changes subscription echoes it to any
  // other open view. Casting-cost enforcement (slots, action economy) is
  // deliberately absent — Prompts 51/53 own that.
  async function handleStartConcentrating(spellName: string) {
    setSaveError(null);
    try {
      setCharacter(await startConcentrating(createBrowserSupabaseClient(), character.id, spellName));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not start concentrating.");
    }
  }

  async function handleStopConcentrating() {
    setSaveError(null);
    try {
      setCharacter(await stopConcentrating(createBrowserSupabaseClient(), character.id));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not stop concentrating.");
    }
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

  async function takeShortRest() {
    setSaveError(null);
    const supabase = createBrowserSupabaseClient();
    try {
      await shortRest(supabase, character.id);
      setResources((rs) => rs.map((r) => (r.recharge === "short_rest" ? { ...r, current_uses: r.max_uses } : r)));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not take a short rest.");
    }
  }

  async function takeLongRest() {
    setSaveError(null);
    const supabase = createBrowserSupabaseClient();
    try {
      await longRest(supabase, character.id);
      setResources((rs) => rs.map((r) => ({ ...r, current_uses: r.max_uses })));
      setCharacter((c) => ({ ...c, current_hp: c.max_hp }));
      setHpDraft(String(character.max_hp));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not take a long rest.");
    }
  }

  // The die itself is rolled server-side by the roll Route Handler; the
  // sheet only sends which roll to make (and the advantage mode) and shows
  // the persisted result. The shared table log picks the insert up via its
  // own postgres_changes subscription.
  async function doRoll(request: RollRequest) {
    if (rolling) return;
    setRolling(true);
    setRollError(null);
    try {
      setLastRoll(await postRoll(campaignId, request));
    } catch (err) {
      setRollError(err instanceof Error ? err.message : "The roll failed — try again.");
    } finally {
      setRolling(false);
    }
  }

  function skillTestId(skill: SkillName): string {
    return skill.toLowerCase().replace(/\s+/g, "-");
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
              {character.current_hp === 0 ? (
                <span className={styles.deathSaveStatus} data-testid="sheet-death-save-status">
                  {character.is_dead ? (
                    <Badge tone="red" data-testid="sheet-death-save-dead">
                      Dead
                    </Badge>
                  ) : character.is_stable ? (
                    <Badge tone="teal" data-testid="sheet-death-save-stable">
                      Stable
                    </Badge>
                  ) : (
                    <>
                      <Badge tone="red">Dying</Badge>
                      <span className={styles.deathSaveTally} data-testid="sheet-death-save-tally">
                        ✓ {character.death_save_successes}/3 · ✗ {character.death_save_failures}/3
                      </span>
                    </>
                  )}
                </span>
              ) : null}
              {character.concentrating_on !== null ? (
                <span className={styles.concentrationStatus} data-testid="sheet-concentration-status">
                  <Badge tone="purple">Concentrating</Badge>
                  <span className={styles.concentrationSpell} data-testid="sheet-concentration-spell">
                    {character.concentrating_on}
                  </span>
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleStopConcentrating}
                      data-testid="sheet-stop-concentrating"
                    >
                      Stop concentrating
                    </Button>
                  ) : null}
                </span>
              ) : null}
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

        <Panel title="Conditions" tone="pink">
          {conditions.length === 0 ? (
            <p className={styles.emptyHint} data-testid="sheet-conditions-empty">
              No active conditions.
            </p>
          ) : (
            <ul className={styles.rowList} data-testid="sheet-conditions">
              {conditions.map((condition) => {
                const exhaustion = condition.condition_key === EXHAUSTION_KEY;
                const definition = exhaustion
                  ? null
                  : CONDITION_BY_KEY.get(condition.condition_key as ConditionKey);
                return (
                  <li
                    key={condition.condition_key}
                    className={styles.itemRow}
                    data-testid={`sheet-condition-${condition.condition_key}`}
                  >
                    <span className={styles.itemName}>
                      <Badge tone="orange">
                        {exhaustion
                          ? `Exhaustion ${condition.level}`
                          : (definition?.name ?? condition.condition_key)}
                      </Badge>
                    </span>
                    <span className={styles.conditionDescription}>
                      {exhaustion
                        ? (EXHAUSTION_LEVEL_DESCRIPTIONS[condition.level ?? 0] ?? "")
                        : (definition?.description ?? "")}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          title="Dice"
          tone="teal"
          headerActions={
            <AdvantageToggle
              mode={rollMode}
              onChange={setRollMode}
              disabled={rolling}
              testIdPrefix="sheet"
            />
          }
        >
          {rollError ? (
            <p className={styles.saveError} role="alert" data-testid="sheet-roll-error">
              {rollError}
            </p>
          ) : null}
          {canEdit &&
          character.current_hp === 0 &&
          !character.is_stable &&
          !character.is_dead ? (
            // Surfaced regardless of whose combat turn it is — a dying
            // player may have only the sheet open. The server rolls a
            // plain d20 (no modifiers, no advantage) and applies the
            // outcome via apply_death_save_roll.
            <div className={styles.deathSaveRow} data-testid="sheet-death-save-prompt">
              <span className={styles.deathSavePromptText}>
                {character.name} is dying — a plain d20, no modifiers.
              </span>
              <Button
                variant="danger"
                size="sm"
                disabled={rolling}
                onClick={() => doRoll({ kind: "death_save", characterId: character.id })}
                data-testid="sheet-roll-death-save"
              >
                Roll death save
              </Button>
            </div>
          ) : null}
          {canEdit && character.pending_concentration_dc !== null ? (
            // The death-save prompt's shape for the damage-triggered
            // concentration check — server-authoritative (the stored
            // pending DC, live-synced via the row subscription), so it
            // persists here until resolved no matter whose click dealt
            // the damage.
            <div className={styles.concentrationPromptRow} data-testid="sheet-concentration-prompt">
              <span className={styles.deathSavePromptText}>
                {character.name} took damage while concentrating
                {character.concentrating_on ? ` on ${character.concentrating_on}` : ""} — roll a
                Constitution save (DC {character.pending_concentration_dc}).
              </span>
              <Button
                variant="accent"
                size="sm"
                disabled={rolling}
                onClick={() => doRoll({ kind: "concentration_save", characterId: character.id })}
                data-testid="sheet-roll-concentration-save"
              >
                Roll concentration save
              </Button>
            </div>
          ) : null}
          {lastRoll ? (
            <div className={styles.rollResult} data-testid="sheet-roll-result">
              <span className={styles.rollHeadline} data-testid="sheet-roll-headline">
                {rollHeadline(lastRoll)}
              </span>
              <span className={styles.rollDetail} data-testid="sheet-roll-detail">
                {rollDetail(lastRoll)}
              </span>
            </div>
          ) : (
            <p className={styles.emptyHint}>
              Roll a check, save, or skill below — every roll lands in the table&apos;s shared log.
            </p>
          )}
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
                <span className={styles.rollRow}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={rolling}
                    onClick={() =>
                      doRoll({ kind: "check", characterId: character.id, ability, mode: rollMode })
                    }
                    data-testid={`roll-check-${ability}`}
                  >
                    Check
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={rolling}
                    onClick={() =>
                      doRoll({ kind: "save", characterId: character.id, ability, mode: rollMode })
                    }
                    data-testid={`roll-save-${ability}`}
                  >
                    Save
                  </Button>
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
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={rolling}
                  onClick={() =>
                    doRoll({
                      kind: "skill",
                      characterId: character.id,
                      skill: skill.name,
                      mode: rollMode,
                    })
                  }
                  data-testid={`roll-skill-${skillTestId(skill.name)}`}
                >
                  Roll
                </Button>
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
                              {canEdit && spell?.concentration ? (
                                // The Prompt 50 "casting" surface: a manual
                                // toggle only — no slot spend, no action
                                // economy (Prompts 51/53). Starting while
                                // already concentrating silently replaces
                                // the old spell.
                                <Button
                                  variant="teal"
                                  size="sm"
                                  disabled={character.concentrating_on === known.name}
                                  onClick={() => handleStartConcentrating(known.name)}
                                  data-testid={`start-concentrating-${known.name.toLowerCase().replace(/\s+/g, "-")}`}
                                >
                                  {character.concentrating_on === known.name
                                    ? "Concentrating"
                                    : "Start concentrating"}
                                </Button>
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

        <Panel
          title="Resources"
          tone="teal"
          headerActions={
            canEdit ? (
              <span className={styles.headerBadges}>
                <Button variant="ghost" size="sm" onClick={takeShortRest}>
                  Short rest
                </Button>
                <Button variant="ghost" size="sm" onClick={takeLongRest}>
                  Long rest
                </Button>
              </span>
            ) : null
          }
        >
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
