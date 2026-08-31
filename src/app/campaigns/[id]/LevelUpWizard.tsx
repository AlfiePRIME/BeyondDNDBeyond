"use client";

import { useEffect, useState } from "react";
import {
  CLASSES,
  SPELLS,
  SPELL_SLOT_LEVELS,
  abilityModifier,
  applyAbilityScoreImprovement,
  asiLevelsForClass,
  featureDescription,
  featuresGainedBetween,
  isValidAbilityScoreImprovementChoice,
  levelUpHitPointGain,
  newSpellsKnownDelta,
  spellSlotResourceName,
  spellSlotsForClass,
  subclassGateLevel,
  subclassesForClass,
  type AbilityScore,
  type AbilityScoreImprovementChoice,
  type AbilityScores,
  type SpellSlotLevel,
} from "@/rules-engine";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import {
  createCharacterResource,
  growCharacterResourceMax,
  listCharacterResources,
  updateCharacter,
  type Character,
  type CharacterResource,
  type KnownSpell,
} from "@/data-access";
import { Badge, Button, ChoiceCard, Modal, Select } from "@/ui-components";
import styles from "./levelUpWizard.module.css";

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

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** "1st-Level Spell Slots" -> "1st-Level" — reuses spellSlotResourceName's
 * own ordinal text instead of a second hand-copied table. */
function slotLabel(level: SpellSlotLevel): string {
  return spellSlotResourceName(level).replace(" Spell Slots", "");
}

type StepKey = "features" | "subclass" | "slots" | "spells" | "asi" | "hp" | "review";

const STEP_TITLE: Record<StepKey, string> = {
  features: "Class Features",
  subclass: "Choose a Subclass",
  slots: "Spell Slots",
  spells: "New Spells",
  asi: "Ability Score Improvement",
  hp: "Hit Points",
  review: "Review & Confirm",
};

/**
 * The guided level-up flow — replaces the one-click "level up" action on
 * BOTH the character sheet and the DM party dashboard (see those files'
 * own doc comments for why a single shared component: both pages had
 * their own entry point into the same underlying math, and both now open
 * the exact same walkthrough rather than diverging). Walks whoever
 * triggers it (the player from their own sheet, or the DM from the party
 * dashboard) through everything a level gain gives a character: new base
 * class (and, if already chosen, subclass) features, a subclass pick at
 * the class's own SRD gate level, spell slot growth (including resyncing
 * MAX_USES on already-existing slot rows — the gap the old per-page-load
 * provisioning left, see data-access/characterResources.ts's
 * growCharacterResourceMax), new spells for casters, an Ability Score
 * Improvement at the class's own named ASI levels, the existing SRD
 * average-hit-die HP gain, and a final review before one combined commit.
 *
 * Mounted-is-open by design (no internal `open` prop/toggle): the caller
 * conditionally renders this component only while its own "wizard is
 * open" state is true (see CharacterSheet.tsx/PartyDashboard.tsx), so
 * every open is a genuinely fresh mount with fresh step/pick state — no
 * manual "reset on reopen" effect needed, and each mount's one data fetch
 * (this character's current resources, for the spell-slot resync step)
 * naturally runs exactly once. Only ever advances ONE level per mount
 * (capped at 20) — a DM awarding a huge XP jump crossing several
 * thresholds just reopens this once per level, exactly like the
 * dashboard's old suggest-then-confirm design.
 */
export function LevelUpWizard({
  onClose,
  character,
  onApplied,
}: {
  onClose: () => void;
  character: Character;
  /** Called with the fully updated character row and the HP gain applied,
   * once the level-up commits — callers use the HP gain to phrase their
   * own local confirmation notice the same way the old one-click action
   * did ("Leveled up to N — hit points +M..."). */
  onApplied: (updated: Character, hpGain: number) => void;
}) {
  const klass = CLASSES.find((c) => c.name === character.class) ?? null;
  const isCaster = Boolean(klass?.spellcastingAbility);
  const oldLevel = character.level;
  const newLevel = Math.min(20, oldLevel + 1);
  const canLevelUp = Boolean(klass) && oldLevel < 20;

  const [stepIndex, setStepIndex] = useState(0);
  const [resources, setResources] = useState<CharacterResource[] | null>(null);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const [subclassPick, setSubclassPick] = useState<string | null>(null);
  const [chosenSpells, setChosenSpells] = useState<KnownSpell[]>([]);
  const [asiMode, setAsiMode] = useState<"single" | "double">("single");
  const [asiSingle, setAsiSingle] = useState<AbilityScore | "">("");
  const [asiDoubleA, setAsiDoubleA] = useState<AbilityScore | "">("");
  const [asiDoubleB, setAsiDoubleB] = useState<AbilityScore | "">("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The one genuine effect this component needs: fetching this
  // character's current resources (for the spell-slot resync step) once
  // per mount — a fresh mount happens automatically every time the caller
  // opens the wizard (see the mounted-is-open doc comment above), so
  // there's no dependency on an "open" flag here at all.
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    let cancelled = false;
    listCharacterResources(supabase, character.id)
      .then((rows) => {
        if (!cancelled) setResources(rows);
      })
      .catch((err) => {
        if (!cancelled) {
          setResourcesError(err instanceof Error ? err.message : "Could not load this character's resources.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [character.id]);

  const gateLevel = klass ? subclassGateLevel(klass.name) : null;
  // "Owed a choice" if the class's gate is at or before the level being
  // reached and none is chosen yet — covers both a level-up that crosses
  // the gate normally AND a legacy character (every character predates
  // this column) that's already past it. See migration
  // 0106_character_subclass.sql's own doc comment for the same reasoning.
  const needsSubclassChoice =
    klass !== null && gateLevel !== null && character.subclass === null && newLevel >= gateLevel;
  const subclassOptions = klass ? subclassesForClass(klass.name) : [];

  // Step 1's feature diff uses the character's EXISTING subclass only
  // (null if none yet) — a subclass picked in step 2 of THIS session shows
  // its own first-tier features on that step directly, not looped back
  // into step 1. Plain consts (not useMemo) throughout this component —
  // the React Compiler already memoizes render output automatically, and
  // klass/oldSlots/newSlots are cheap catalog lookups/pure math, not
  // expensive recomputation worth hand-memoizing.
  const baseFeatureDiff = klass
    ? featuresGainedBetween(klass.name, character.subclass, oldLevel, newLevel).filter(
        (f) => f.name !== "Ability Score Improvement"
      )
    : [];

  const oldSlots = klass ? spellSlotsForClass(klass.name, oldLevel) : null;
  const newSlots = klass ? spellSlotsForClass(klass.name, newLevel) : null;
  const slotDiffLevels =
    oldSlots && newSlots ? SPELL_SLOT_LEVELS.filter((level) => newSlots[level] !== oldSlots[level]) : [];
  const needsSlotStep = isCaster && slotDiffLevels.length > 0;

  const spellcastingAbilityScore =
    klass?.spellcastingAbility ? character[klass.spellcastingAbility] : null;
  const spellDelta =
    klass && isCaster && spellcastingAbilityScore !== null
      ? newSpellsKnownDelta(klass.name, oldLevel, newLevel, abilityModifier(spellcastingAbilityScore))
      : 0;
  const needsSpellStep = isCaster && spellDelta > 0;
  const availableSpellLevels = newSlots
    ? [0, ...SPELL_SLOT_LEVELS.filter((level) => newSlots[level] > 0)]
    : [0];
  const learnableSpells = klass
    ? SPELLS.filter(
        (spell) =>
          spell.classes.includes(klass.name) &&
          availableSpellLevels.includes(spell.level) &&
          !character.spells.some((known) => known.name === spell.name) &&
          !chosenSpells.some((picked) => picked.name === spell.name)
      ).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
    : [];

  const asiLevels = klass ? asiLevelsForClass(klass.name, character.subclass ?? subclassPick) : [];
  const needsAsiStep = asiLevels.includes(newLevel);
  const asiChoice: AbilityScoreImprovementChoice | null =
    asiMode === "single"
      ? asiSingle
        ? { mode: "single", ability: asiSingle }
        : null
      : asiDoubleA && asiDoubleB && asiDoubleA !== asiDoubleB
        ? { mode: "double", abilities: [asiDoubleA, asiDoubleB] }
        : null;

  const currentScores: AbilityScores = {
    strength: character.strength,
    dexterity: character.dexterity,
    constitution: character.constitution,
    intelligence: character.intelligence,
    wisdom: character.wisdom,
    charisma: character.charisma,
  };
  const finalScores =
    needsAsiStep && asiChoice ? applyAbilityScoreImprovement(currentScores, asiChoice) : currentScores;
  const hpGain = klass ? levelUpHitPointGain(klass.hitDie, finalScores.constitution) : 0;

  const steps: StepKey[] = ["features"];
  if (needsSubclassChoice) steps.push("subclass");
  if (needsSlotStep) steps.push("slots");
  if (needsSpellStep) steps.push("spells");
  if (needsAsiStep) steps.push("asi");
  steps.push("hp", "review");

  const currentStep = steps[Math.min(stepIndex, steps.length - 1)];
  const isReview = currentStep === "review";

  function stepIsValid(step: StepKey): boolean {
    if (step === "subclass") return subclassPick !== null;
    if (step === "asi") return isValidAbilityScoreImprovementChoice(asiChoice);
    return true;
  }

  function toggleSpell(name: string, level: number) {
    setChosenSpells((current) =>
      current.some((s) => s.name === name)
        ? current.filter((s) => s.name !== name)
        : [...current, { name, level }]
    );
  }

  async function handleConfirm() {
    if (!klass || resources === null) return;
    setSaving(true);
    setSaveError(null);
    const supabase = createBrowserSupabaseClient();
    try {
      const nextSpells: KnownSpell[] = [...character.spells, ...chosenSpells];
      const updated = await updateCharacter(supabase, character.id, {
        level: newLevel,
        current_hp: character.current_hp + hpGain,
        max_hp: character.max_hp + hpGain,
        ...finalScores,
        spells: nextSpells,
        ...(subclassPick ? { subclass: subclassPick } : {}),
      });

      // Spell-slot resync: bump MAX_USES (and current_uses by the same
      // delta) on rows that already exist, create rows that don't — the
      // gap the character sheet page's own load-time provisioning leaves
      // (it only ever creates MISSING rows, never resizes an existing
      // one). Deliberately checked against EVERY currently-relevant slot
      // level (newSlots[level] > 0), not just the levels slotDiffLevels
      // says changed THIS level-up: the existing row's actual max_uses is
      // the source of truth to resync against, not the theoretical old-
      // level SRD count, so a row that's stale or was never created for
      // an unrelated reason (e.g. a character leveled up before ever
      // loading their own sheet) still gets corrected here rather than
      // silently staying wrong. slotDiffLevels itself stays the "what
      // changed at THIS level" figure the Spell Slots step displays.
      if (isCaster && newSlots) {
        for (const level of SPELL_SLOT_LEVELS) {
          if (newSlots[level] <= 0) continue;
          const existing = resources.find((r) => r.name === spellSlotResourceName(level));
          if (existing) {
            if (existing.max_uses !== newSlots[level]) {
              await growCharacterResourceMax(supabase, existing, newSlots[level] - existing.max_uses);
            }
          } else {
            await createCharacterResource(supabase, {
              character_id: character.id,
              name: spellSlotResourceName(level),
              max_uses: newSlots[level],
              current_uses: newSlots[level],
              recharge: "long_rest",
            });
          }
        }
      }

      onApplied(updated, hpGain);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not apply the level-up.");
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <div className={styles.footerNav}>
      <Button
        variant="ghost"
        onClick={() => (stepIndex === 0 ? onClose() : setStepIndex((i) => i - 1))}
        disabled={saving}
        data-testid="levelup-back"
      >
        {stepIndex === 0 ? "Cancel" : "Back"}
      </Button>
      {!isReview ? (
        <Button
          onClick={() => setStepIndex((i) => i + 1)}
          disabled={!stepIsValid(currentStep) || resources === null}
          data-testid="levelup-next"
        >
          Next
        </Button>
      ) : (
        <Button onClick={handleConfirm} disabled={saving || resources === null} data-testid="levelup-confirm">
          {saving ? "Applying…" : `Confirm level ${newLevel}`}
        </Button>
      )}
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={`Level Up — ${character.name}`}
      footer={!canLevelUp ? undefined : footer}
      size="wide"
    >
      <div className={styles.wizard} data-testid="level-up-wizard">
        {!canLevelUp ? (
          <p className={styles.detailText}>
            {oldLevel >= 20
              ? `${character.name} is already at the SRD maximum level (20).`
              : "Unknown class — can't compute an SRD level-up for this character."}
          </p>
        ) : (
          <>
            <div className={styles.stepBadges}>
              {steps.map((step, i) => (
                <Badge key={step} tone={i === stepIndex ? "purple" : "neutral"}>
                  {STEP_TITLE[step]}
                </Badge>
              ))}
            </div>

            {resourcesError ? (
              <p className={styles.footerError} role="alert">
                {resourcesError}
              </p>
            ) : resources === null ? (
              <p className={styles.detailText}>Loading…</p>
            ) : null}

            <div className={styles.stepBody} data-testid={`levelup-step-${currentStep}`}>
              <Badge tone="teal">
                {character.class} {oldLevel} → {newLevel}
              </Badge>

              {currentStep === "features" ? (
                baseFeatureDiff.length === 0 ? (
                  <p className={styles.detailText} data-testid="levelup-features-empty">
                    No new base class features at this level — see the Ability Score Improvement and
                    Hit Points steps for what this level gains instead.
                  </p>
                ) : (
                  <ul className={styles.featureList}>
                    {baseFeatureDiff.map((feature) => (
                      <li
                        key={feature.name}
                        className={styles.featureRow}
                        data-testid={`levelup-feature-${slug(feature.name)}`}
                      >
                        <span className={styles.featureName}>
                          {feature.name} <Badge tone="neutral">Level {feature.level}</Badge>
                        </span>
                        <span className={styles.featureDescription}>{featureDescription(feature.name)}</span>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}

              {currentStep === "subclass" ? (
                <>
                  <p className={styles.detailText}>
                    {character.class} chooses its subclass now — pick one to continue.
                  </p>
                  <div className={styles.cardGrid}>
                    {subclassOptions.map((subclass) => (
                      <ChoiceCard
                        key={subclass.name}
                        title={subclass.name}
                        selected={subclassPick === subclass.name}
                        onClick={() => setSubclassPick(subclass.name)}
                        data-testid={`levelup-subclass-choice-${slug(subclass.name)}`}
                      />
                    ))}
                  </div>
                  {subclassPick ? (
                    <ul className={styles.featureList} data-testid="levelup-subclass-features">
                      {(subclassOptions.find((s) => s.name === subclassPick)?.features ?? [])
                        .filter((f) => f.level <= newLevel)
                        .map((feature) => (
                          <li key={feature.name} className={styles.featureRow}>
                            <span className={styles.featureName}>
                              {feature.name} <Badge tone="neutral">Level {feature.level}</Badge>
                            </span>
                            <span className={styles.featureDescription}>
                              {featureDescription(feature.name)}
                            </span>
                          </li>
                        ))}
                    </ul>
                  ) : null}
                </>
              ) : null}

              {currentStep === "slots" && oldSlots && newSlots ? (
                <ul className={styles.slotList}>
                  {slotDiffLevels.map((level) => (
                    <li key={level} className={styles.slotRow} data-testid={`levelup-slot-${level}`}>
                      <span className={styles.featureName}>{slotLabel(level)}</span>
                      <span>
                        {oldSlots[level]} → {newSlots[level]}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {currentStep === "spells" ? (
                <>
                  <p className={styles.detailText}>
                    You can learn up to <strong>{spellDelta}</strong> new spell
                    {spellDelta === 1 ? "" : "s"} this level (optional — pick as many or as few as you
                    like).{" "}
                    <Badge tone="purple" data-testid="levelup-spells-picked-count">
                      {chosenSpells.length} picked
                    </Badge>
                  </p>
                  <div className={styles.spellScroll}>
                    {availableSpellLevels.map((level) => {
                      const atLevel = learnableSpells.filter((s) => s.level === level);
                      if (atLevel.length === 0) return null;
                      return (
                        <div key={level} className={styles.group}>
                          <span className={styles.groupLabel}>
                            {level === 0 ? "Cantrips" : `${slotLabel(level as SpellSlotLevel)} spells`}
                          </span>
                          <div className={styles.cardGrid}>
                            {atLevel.map((spell) => (
                              <ChoiceCard
                                key={spell.name}
                                title={spell.name}
                                meta={spell.school}
                                selected={chosenSpells.some((s) => s.name === spell.name)}
                                onClick={() => toggleSpell(spell.name, spell.level)}
                                data-testid={`levelup-spell-${slug(spell.name)}`}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : null}

              {currentStep === "asi" ? (
                <>
                  <p className={styles.detailText}>Increase one ability score by 2, or two by 1 each.</p>
                  <div className={styles.detailRow}>
                    <Button
                      size="sm"
                      variant={asiMode === "single" ? "accent" : "ghost"}
                      onClick={() => setAsiMode("single")}
                      data-testid="levelup-asi-mode-single"
                    >
                      +2 to one score
                    </Button>
                    <Button
                      size="sm"
                      variant={asiMode === "double" ? "accent" : "ghost"}
                      onClick={() => setAsiMode("double")}
                      data-testid="levelup-asi-mode-double"
                    >
                      +1 to two scores
                    </Button>
                  </div>
                  {asiMode === "single" ? (
                    <Select
                      label="Ability"
                      value={asiSingle}
                      onChange={(e) => setAsiSingle(e.target.value as AbilityScore | "")}
                      data-testid="levelup-asi-single-ability"
                    >
                      <option value="">Choose an ability…</option>
                      {ABILITIES.map((ability) => (
                        <option key={ability} value={ability}>
                          {ABILITY_LABEL[ability]} ({currentScores[ability]} → {currentScores[ability] + 2})
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <div className={styles.abilityGrid}>
                      <Select
                        label="First ability"
                        value={asiDoubleA}
                        onChange={(e) => setAsiDoubleA(e.target.value as AbilityScore | "")}
                        data-testid="levelup-asi-double-ability-a"
                      >
                        <option value="">Choose an ability…</option>
                        {ABILITIES.filter((a) => a !== asiDoubleB).map((ability) => (
                          <option key={ability} value={ability}>
                            {ABILITY_LABEL[ability]} ({currentScores[ability]} → {currentScores[ability] + 1})
                          </option>
                        ))}
                      </Select>
                      <Select
                        label="Second ability"
                        value={asiDoubleB}
                        onChange={(e) => setAsiDoubleB(e.target.value as AbilityScore | "")}
                        data-testid="levelup-asi-double-ability-b"
                      >
                        <option value="">Choose an ability…</option>
                        {ABILITIES.filter((a) => a !== asiDoubleA).map((ability) => (
                          <option key={ability} value={ability}>
                            {ABILITY_LABEL[ability]} ({currentScores[ability]} → {currentScores[ability] + 1})
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                </>
              ) : null}

              {currentStep === "hp" ? (
                <p className={styles.detailText} data-testid="levelup-hp-gain">
                  {klass ? (
                    <>
                      SRD average hit points for a d{klass.hitDie} hit die at Constitution{" "}
                      {finalScores.constitution} ({formatModifier(abilityModifier(finalScores.constitution))}):{" "}
                      <strong>+{hpGain}</strong> — {character.current_hp} → {character.current_hp + hpGain} (max{" "}
                      {character.max_hp} → {character.max_hp + hpGain}).
                    </>
                  ) : null}
                </p>
              ) : null}

              {currentStep === "review" ? (
                <ul className={styles.summaryList} data-testid="levelup-review">
                  <li className={styles.summaryRow}>
                    <span className={styles.summaryLabel}>Level</span>
                    <span className={styles.summaryValue}>
                      {oldLevel} → {newLevel}
                    </span>
                  </li>
                  {subclassPick ? (
                    <li className={styles.summaryRow}>
                      <span className={styles.summaryLabel}>Subclass</span>
                      <span className={styles.summaryValue}>{subclassPick}</span>
                    </li>
                  ) : null}
                  <li className={styles.summaryRow}>
                    <span className={styles.summaryLabel}>Features gained</span>
                    <span className={styles.summaryValue}>
                      {baseFeatureDiff.map((f) => f.name).join(", ") || "None"}
                    </span>
                  </li>
                  {needsSlotStep && oldSlots && newSlots ? (
                    <li className={styles.summaryRow}>
                      <span className={styles.summaryLabel}>Spell slots</span>
                      <span className={styles.summaryValue}>
                        {slotDiffLevels
                          .map((level) => `${slotLabel(level)} ${oldSlots[level]}→${newSlots[level]}`)
                          .join(", ")}
                      </span>
                    </li>
                  ) : null}
                  {isCaster ? (
                    <li className={styles.summaryRow}>
                      <span className={styles.summaryLabel}>New spells</span>
                      <span className={styles.summaryValue}>
                        {chosenSpells.map((s) => s.name).join(", ") || "None picked"}
                      </span>
                    </li>
                  ) : null}
                  {needsAsiStep ? (
                    <li className={styles.summaryRow}>
                      <span className={styles.summaryLabel}>Ability score improvement</span>
                      <span className={styles.summaryValue}>
                        {ABILITIES.filter((a) => finalScores[a] !== currentScores[a])
                          .map((a) => `${ABILITY_LABEL[a]} ${currentScores[a]} → ${finalScores[a]}`)
                          .join(", ") || "Not chosen yet"}
                      </span>
                    </li>
                  ) : null}
                  <li className={styles.summaryRow}>
                    <span className={styles.summaryLabel}>Hit points</span>
                    <span className={styles.summaryValue}>
                      +{hpGain} ({character.current_hp + hpGain} / {character.max_hp + hpGain})
                    </span>
                  </li>
                </ul>
              ) : null}
            </div>

            {saveError ? (
              <p className={styles.footerError} role="alert" data-testid="levelup-error">
                {saveError}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}
