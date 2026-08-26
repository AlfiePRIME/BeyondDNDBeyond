"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  RACES,
  CLASSES,
  SPELLS,
  STARTING_EQUIPMENT,
  abilityModifier,
  proficiencyBonus,
  resolveRaceOption,
  savingThrowBonus,
  attackBonus,
  spellSlotsForClass,
  levelOneHitPoints,
  type AbilityScore,
  type AbilityScores,
  type SpellRange,
} from "@/rules-engine";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { createCharacter, type InventoryItem, type KnownSpell } from "@/data-access";
import { Badge, Button, ChoiceCard, Panel, SectionHeader, Select, TextInput } from "@/ui-components";
import styles from "./wizard.module.css";

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

// SRD standard array, pre-assigned in the conventional order as a starting
// point — every field is freely editable.
const DEFAULT_BASE_SCORES: Record<AbilityScore, string> = {
  strength: "15",
  dexterity: "14",
  constitution: "13",
  intelligence: "12",
  wisdom: "10",
  charisma: "8",
};

// Sentinel `raceName` value for the homebrew card — never a real RACES
// entry, never written to storage. Selecting it takes the wizard off the
// SRD-derivation path entirely: race/subrace stay null, so every place that
// derives from them (increases, raceStats, resolveRaceOption) naturally
// falls back to nothing, and the homebrew-specific fields below take over.
const HOMEBREW_RACE_OPTION = "__homebrew__";

// A homebrew race starts with no racial ability bonuses (an explicit,
// visible "0" the player edits — not a silent default) and no darkvision;
// speed is seeded at the SRD's most common value (also this file's existing
// fallback for an unresolved race) purely as a convenient starting point.
const DEFAULT_HOMEBREW_ABILITY_BONUSES: Record<AbilityScore, string> = {
  strength: "0",
  dexterity: "0",
  constitution: "0",
  intelligence: "0",
  wisdom: "0",
  charisma: "0",
};

function formatModifier(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

function formatRange(range: SpellRange): string {
  return typeof range === "number" ? `${range} ft` : range;
}

function parseScore(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 20 ? value : null;
}

// Homebrew ability bonuses are additive adjustments, not scores — no 1-20
// clamp, and negative is allowed (a homebrew race's flaw). Unparseable
// input blocks the step exactly like an invalid base score does, rather
// than silently coercing to zero.
function parseBonus(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

// Speed/darkvision are plain non-negative feet values. No upper bound is
// enforced — per the brief, this is deliberately not the place to police
// whether a homebrew number is "reasonable".
function parseFeet(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function CharacterWizard({
  campaignId,
  campaignName,
  userId,
}: {
  campaignId: string;
  campaignName: string;
  userId: string;
}) {
  const router = useRouter();

  const [stepIndex, setStepIndex] = useState(0);
  const [name, setName] = useState("");
  const [raceName, setRaceName] = useState<string | null>(null);
  const [subraceName, setSubraceName] = useState("");
  const [homebrewRaceName, setHomebrewRaceName] = useState("");
  const [homebrewSpeed, setHomebrewSpeed] = useState("30");
  const [homebrewDarkvision, setHomebrewDarkvision] = useState("0");
  const [homebrewAbilityBonuses, setHomebrewAbilityBonuses] = useState<Record<AbilityScore, string>>(
    DEFAULT_HOMEBREW_ABILITY_BONUSES
  );
  const [className, setClassName] = useState<string | null>(null);
  const [baseScores, setBaseScores] = useState(DEFAULT_BASE_SCORES);
  const [bonusPicks, setBonusPicks] = useState<(AbilityScore | "")[]>([]);
  const [equipmentPicks, setEquipmentPicks] = useState<number[]>([]);
  const [chosenSpells, setChosenSpells] = useState<KnownSpell[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const race = RACES.find((r) => r.name === raceName) ?? null;
  const subrace = race?.subraces?.find((s) => s.name === subraceName) ?? null;
  const isHomebrewRace = raceName === HOMEBREW_RACE_OPTION;
  // "Chosen" for a homebrew pick means a non-empty name, not a catalog
  // match — this is the genuinely-chosen case the `!race` validation used
  // to treat as nothing-chosen.
  const raceChosen = isHomebrewRace ? homebrewRaceName.trim().length > 0 : Boolean(race);
  const resolvedRaceName = isHomebrewRace
    ? homebrewRaceName.trim()
    : (subrace ? subrace.name : race?.name) ?? "";
  const klass = CLASSES.find((c) => c.name === className) ?? null;
  const equipment = klass ? STARTING_EQUIPMENT.find((e) => e.className === klass.name) : null;
  const isCaster = Boolean(klass?.spellcastingAbility);

  const increases = useMemo(
    () => [...(race?.abilityScoreIncreases ?? []), ...(subrace?.abilityScoreIncreases ?? [])],
    [race, subrace]
  );
  const choiceIncreases = useMemo(
    () => increases.filter((inc) => inc.ability === "choice"),
    [increases]
  );
  const fixedBonusAbilities = new Set(
    increases.filter((inc) => inc.ability !== "choice").map((inc) => inc.ability)
  );

  const parsedBaseScores = useMemo(() => {
    const out = {} as AbilityScores;
    for (const ability of ABILITIES) {
      const value = parseScore(baseScores[ability]);
      if (value === null) return null;
      out[ability] = value;
    }
    return out;
  }, [baseScores]);

  // A homebrew race's ability bonuses come straight from the manual fields
  // instead of a catalog `abilityScoreIncreases` list — direct player
  // control in place of the fixed-race derivation, applied the same way
  // (added onto the base score) so the rest of the calc below doesn't need
  // to know which source it came from.
  const parsedHomebrewBonuses = useMemo(() => {
    if (!isHomebrewRace) return null;
    const out = {} as AbilityScores;
    for (const ability of ABILITIES) {
      const value = parseBonus(homebrewAbilityBonuses[ability]);
      if (value === null) return null;
      out[ability] = value;
    }
    return out;
  }, [isHomebrewRace, homebrewAbilityBonuses]);

  const finalScores = useMemo(() => {
    if (!parsedBaseScores) return null;
    const out = { ...parsedBaseScores };
    for (const inc of increases) {
      if (inc.ability !== "choice") out[inc.ability] += inc.amount;
    }
    choiceIncreases.forEach((inc, i) => {
      const pick = bonusPicks[i];
      if (pick) out[pick] += inc.amount;
    });
    if (isHomebrewRace) {
      if (!parsedHomebrewBonuses) return null;
      for (const ability of ABILITIES) out[ability] += parsedHomebrewBonuses[ability];
    }
    return out;
  }, [parsedBaseScores, increases, choiceIncreases, bonusPicks, isHomebrewRace, parsedHomebrewBonuses]);

  const racialBonus = (ability: AbilityScore): number =>
    increases
      .filter((inc) => inc.ability === ability)
      .reduce((sum, inc) => sum + inc.amount, 0) +
    choiceIncreases.reduce(
      (sum, inc, i) => (bonusPicks[i] === ability ? sum + inc.amount : sum),
      0
    ) +
    (isHomebrewRace ? parseBonus(homebrewAbilityBonuses[ability]) ?? 0 : 0);

  const inventory: InventoryItem[] = useMemo(() => {
    if (!equipment) return [];
    const items = [...equipment.fixed];
    equipment.choices.forEach((choice, i) => {
      const pick = equipmentPicks[i];
      if (pick !== undefined && pick >= 0) items.push(...choice.options[pick]);
    });
    return items.map((item) => ({ name: item, quantity: 1 }));
  }, [equipment, equipmentPicks]);

  // Subrace overrides race where both define it (e.g. a Drow's 120 ft
  // darkvision over the Elf's 60 ft); null darkvision means normal vision
  // only. Resolved by the shared rules-engine resolver from the same
  // race-or-subrace string the row will store, so creation and the sheet's
  // later race edits derive identical stats. Stored on the character at
  // creation.
  const raceStats = race ? resolveRaceOption(subrace ? subrace.name : race.name) : null;
  const parsedHomebrewSpeed = parseFeet(homebrewSpeed);
  const parsedHomebrewDarkvision = parseFeet(homebrewDarkvision);
  // 0 ft darkvision reads as "none" (null), matching the rest of the app's
  // convention (a matched race with no darkvision also stores null) — the
  // field's default of "0" is the sensible off-state, not a silent zero.
  const speed = isHomebrewRace ? parsedHomebrewSpeed ?? 30 : raceStats?.speedFeet ?? 30;
  const darkvisionFeet = isHomebrewRace
    ? parsedHomebrewDarkvision && parsedHomebrewDarkvision > 0
      ? parsedHomebrewDarkvision
      : null
    : raceStats?.darkvisionFeet ?? null;
  const maxHp = klass && finalScores ? levelOneHitPoints(klass.hitDie, finalScores.constitution) : null;
  const armorClass = finalScores ? 10 + abilityModifier(finalScores.dexterity) : null;

  const stepTitles = [
    "Race & Class",
    "Ability Scores",
    "Equipment",
    ...(isCaster ? ["Spells"] : []),
    "Review & Create",
  ];
  const spellStepIndex = isCaster ? 3 : -1;
  const reviewStepIndex = stepTitles.length - 1;

  function selectRace(nextRaceName: string) {
    const nextRace = RACES.find((r) => r.name === nextRaceName);
    setRaceName(nextRaceName);
    setSubraceName("");
    setBonusPicks(
      Array(nextRace?.abilityScoreIncreases.filter((inc) => inc.ability === "choice").length ?? 0).fill("")
    );
  }

  function selectClass(nextClassName: string) {
    const nextEquipment = STARTING_EQUIPMENT.find((e) => e.className === nextClassName);
    setClassName(nextClassName);
    setEquipmentPicks(Array(nextEquipment?.choices.length ?? 0).fill(-1));
    setChosenSpells([]);
  }

  function toggleSpell(spellName: string, level: number) {
    setChosenSpells((current) =>
      current.some((s) => s.name === spellName)
        ? current.filter((s) => s.name !== spellName)
        : [...current, { name: spellName, level }]
    );
  }

  function stepIsValid(index: number): boolean {
    switch (index) {
      case 0:
        if (isHomebrewRace) {
          return Boolean(
            name.trim() &&
              klass &&
              homebrewRaceName.trim() &&
              parsedHomebrewSpeed !== null &&
              parsedHomebrewDarkvision !== null
          );
        }
        return Boolean(
          name.trim() && race && klass && (!race.subraces?.length || subrace)
        );
      case 1:
        return Boolean(finalScores) && bonusPicks.every((pick) => pick !== "");
      case 2:
        return equipmentPicks.every((pick) => pick >= 0);
      default:
        return true;
    }
  }

  async function handleCreate() {
    // Computed locally (not from the render-scope resolvedRaceName) — a
    // value this closure shares with JSX render output while also
    // depending on the increases-memo's race/subrace inputs defeats the
    // React Compiler's manual-memoization preservation check.
    const raceToSave = isHomebrewRace ? homebrewRaceName.trim() : (subrace ? subrace.name : race?.name);
    if (!raceToSave || !klass || !finalScores || maxHp === null || armorClass === null) return;
    setSaving(true);
    setSaveError(null);

    const supabase = createBrowserSupabaseClient();
    try {
      await createCharacter(supabase, {
        campaign_id: campaignId,
        owner_id: userId,
        name: name.trim(),
        race: raceToSave,
        class: klass.name,
        level: 1,
        ...finalScores,
        current_hp: maxHp,
        max_hp: maxHp,
        armor_class: armorClass,
        speed,
        darkvision_feet: darkvisionFeet,
        proficiencies: klass.savingThrowProficiencies.map(
          (ability) => `${ABILITY_LABEL[ability]} Saving Throws`
        ),
        inventory,
        spells: chosenSpells,
      });
      router.push(`/campaigns/${campaignId}`);
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not create the character.");
      setSaving(false);
    }
  }

  const slots = klass && isCaster ? spellSlotsForClass(klass.name, 1) : null;
  const cantrips = SPELLS.filter((s) => s.level === 0);
  const firstLevelSpells = SPELLS.filter((s) => s.level === 1);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
          ← Back to {campaignName}
        </Link>

        <SectionHeader
          eyebrow={`New character · Step ${stepIndex + 1} of ${stepTitles.length}`}
          title={stepTitles[stepIndex]}
        />

        <div className={styles.stepBadges}>
          {stepTitles.map((title, i) => (
            <Badge key={title} tone={i === stepIndex ? "purple" : "neutral"}>
              {title}
            </Badge>
          ))}
        </div>

        <Panel tone="purple">
          <div className={styles.stepBody}>
            {stepIndex === 0 ? (
              <>
                <TextInput
                  label="Character name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Bram Ironhide"
                  required
                />

                <div className={styles.group}>
                  <span className={styles.groupLabel}>Race</span>
                  <div className={styles.cardGrid}>
                    {RACES.map((r) => (
                      <ChoiceCard
                        key={r.name}
                        title={r.name}
                        meta={`${r.speedFeet} ft speed`}
                        selected={r.name === raceName}
                        onClick={() => selectRace(r.name)}
                      />
                    ))}
                    <ChoiceCard
                      key={HOMEBREW_RACE_OPTION}
                      title="Homebrew / Other"
                      meta="Custom race — set your own stats"
                      selected={isHomebrewRace}
                      onClick={() => selectRace(HOMEBREW_RACE_OPTION)}
                      data-testid="wizard-race-homebrew"
                    />
                  </div>
                  {race ? (
                    <div className={styles.detailRow}>
                      <Badge tone="teal">{race.speedFeet} ft</Badge>
                      {race.darkvisionFeet ? (
                        <Badge tone="teal">Darkvision {race.darkvisionFeet} ft</Badge>
                      ) : null}
                      {race.traits.map((trait) => (
                        <Badge key={trait.name}>{trait.name}</Badge>
                      ))}
                    </div>
                  ) : null}
                </div>

                {race?.subraces?.length ? (
                  <Select
                    label="Subrace"
                    value={subraceName}
                    onChange={(e) => {
                      setSubraceName(e.target.value);
                    }}
                    required
                  >
                    <option value="">Choose a subrace…</option>
                    {race.subraces.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                ) : null}
                {subrace ? (
                  <div className={styles.detailRow}>
                    {subrace.speedFeet ? <Badge tone="teal">{subrace.speedFeet} ft</Badge> : null}
                    {subrace.darkvisionFeet ? (
                      <Badge tone="teal">Darkvision {subrace.darkvisionFeet} ft</Badge>
                    ) : null}
                    {subrace.traits.map((trait) => (
                      <Badge key={trait.name}>{trait.name}</Badge>
                    ))}
                  </div>
                ) : null}

                {isHomebrewRace ? (
                  <div className={styles.group}>
                    <span className={styles.groupLabel}>Homebrew race details</span>
                    <TextInput
                      label="Race name"
                      value={homebrewRaceName}
                      onChange={(e) => setHomebrewRaceName(e.target.value)}
                      placeholder="e.g. Warforged"
                      required
                      data-testid="wizard-homebrew-race-name"
                    />
                    <div className={styles.abilityGrid}>
                      <TextInput
                        label="Speed (ft)"
                        type="number"
                        min={0}
                        value={homebrewSpeed}
                        onChange={(e) => setHomebrewSpeed(e.target.value)}
                        error={parsedHomebrewSpeed === null ? "Enter a whole number, 0 or greater" : undefined}
                        data-testid="wizard-homebrew-speed"
                      />
                      <TextInput
                        label="Darkvision (ft, 0 for none)"
                        type="number"
                        min={0}
                        value={homebrewDarkvision}
                        onChange={(e) => setHomebrewDarkvision(e.target.value)}
                        error={
                          parsedHomebrewDarkvision === null ? "Enter a whole number, 0 or greater" : undefined
                        }
                        data-testid="wizard-homebrew-darkvision"
                      />
                    </div>
                  </div>
                ) : null}

                <div className={styles.group}>
                  <span className={styles.groupLabel}>Class</span>
                  <div className={styles.cardGrid}>
                    {CLASSES.map((c) => (
                      <ChoiceCard
                        key={c.name}
                        title={c.name}
                        meta={`d${c.hitDie} hit die`}
                        selected={c.name === className}
                        onClick={() => selectClass(c.name)}
                      />
                    ))}
                  </div>
                  {klass ? (
                    <div className={styles.detailRow}>
                      <Badge tone="pink">d{klass.hitDie} hit die</Badge>
                      {klass.savingThrowProficiencies.map((ability) => (
                        <Badge key={ability} tone="orange">
                          {ABILITY_LABEL[ability]} save
                        </Badge>
                      ))}
                      <Badge tone={isCaster ? "purple" : "neutral"}>
                        {isCaster
                          ? `${klass.casterProgression} caster (${ABILITY_LABEL[klass.spellcastingAbility!]})`
                          : "Non-caster"}
                      </Badge>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            {stepIndex === 1 && raceChosen && klass ? (
              <>
                <p className={styles.detailText}>
                  Seeded with the standard array (15/14/13/12/10/8) — edit freely.{" "}
                  {isHomebrewRace
                    ? "Set the ability score bonuses for your homebrew race below — they're applied to the final scores."
                    : `Racial increases from ${resolvedRaceName} are applied to the final scores.`}
                </p>
                <div className={styles.abilityGrid}>
                  {ABILITIES.map((ability) => {
                    const bonus = racialBonus(ability);
                    const parsed = parseScore(baseScores[ability]);
                    return (
                      <TextInput
                        key={ability}
                        label={ABILITY_LABEL[ability]}
                        type="number"
                        min={1}
                        max={20}
                        value={baseScores[ability]}
                        onChange={(e) =>
                          setBaseScores((s) => ({ ...s, [ability]: e.target.value }))
                        }
                        error={parsed === null ? "Enter a score from 1 to 20" : undefined}
                        hint={
                          parsed !== null ? (
                            <span className={styles.abilityComputed}>
                              {bonus > 0 ? `${parsed} + ${bonus} = ` : ""}
                              {parsed + bonus} ({formatModifier(abilityModifier(parsed + bonus))})
                            </span>
                          ) : undefined
                        }
                      />
                    );
                  })}
                </div>

                {choiceIncreases.length > 0 ? (
                  <div className={styles.group}>
                    <span className={styles.groupLabel}>{resolvedRaceName} bonus ability choices</span>
                    {choiceIncreases.map((inc, i) => (
                      <Select
                        key={i}
                        label={`+${inc.amount} to`}
                        value={bonusPicks[i] ?? ""}
                        onChange={(e) => {
                          const pick = e.target.value as AbilityScore | "";
                          setBonusPicks((picks) => picks.map((p, j) => (j === i ? pick : p)));
                        }}
                        required
                      >
                        <option value="">Choose an ability…</option>
                        {ABILITIES.filter(
                          (ability) =>
                            !fixedBonusAbilities.has(ability) &&
                            (bonusPicks[i] === ability || !bonusPicks.includes(ability))
                        ).map((ability) => (
                          <option key={ability} value={ability}>
                            {ABILITY_LABEL[ability]}
                          </option>
                        ))}
                      </Select>
                    ))}
                  </div>
                ) : null}

                {isHomebrewRace ? (
                  <div className={styles.group}>
                    <span className={styles.groupLabel}>
                      {homebrewRaceName.trim() || "Homebrew race"} ability score increases
                    </span>
                    <div className={styles.abilityGrid}>
                      {ABILITIES.map((ability) => (
                        <TextInput
                          key={ability}
                          label={`${ABILITY_LABEL[ability]} bonus`}
                          type="number"
                          value={homebrewAbilityBonuses[ability]}
                          onChange={(e) =>
                            setHomebrewAbilityBonuses((b) => ({ ...b, [ability]: e.target.value }))
                          }
                          error={
                            parseBonus(homebrewAbilityBonuses[ability]) === null
                              ? "Enter a whole number"
                              : undefined
                          }
                          data-testid={`wizard-homebrew-bonus-${ability}`}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}

                {finalScores ? (
                  <div className={styles.group}>
                    <span className={styles.groupLabel}>Derived at level 1</span>
                    <div className={styles.detailRow}>
                      <Badge tone="teal">Proficiency {formatModifier(proficiencyBonus(1))}</Badge>
                      {klass.savingThrowProficiencies.map((ability) => (
                        <Badge key={ability} tone="orange">
                          {ABILITY_LABEL[ability]} save{" "}
                          {formatModifier(savingThrowBonus(ability, finalScores, 1, true))}
                        </Badge>
                      ))}
                      {isCaster ? (
                        <Badge tone="purple">
                          Spell attack{" "}
                          {formatModifier(
                            attackBonus("spell", finalScores, 1, klass.spellcastingAbility)
                          )}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            {stepIndex === 2 && equipment ? (
              <>
                {equipment.fixed.length > 0 ? (
                  <div className={styles.group}>
                    <span className={styles.groupLabel}>Included with every {equipment.className}</span>
                    <ul className={styles.itemList}>
                      {equipment.fixed.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className={styles.detailText}>
                    {equipment.className}s start with no fixed items — everything comes from the
                    choices below.
                  </p>
                )}

                {equipment.choices.map((choice, groupIndex) => (
                  <div key={groupIndex} className={styles.group}>
                    <span className={styles.groupLabel}>Choice {groupIndex + 1} — pick one</span>
                    <div className={styles.cardGrid}>
                      {choice.options.map((bundle, optionIndex) => (
                        <ChoiceCard
                          key={optionIndex}
                          title={bundle.join(" + ")}
                          selected={equipmentPicks[groupIndex] === optionIndex}
                          onClick={() =>
                            setEquipmentPicks((picks) =>
                              picks.map((p, j) => (j === groupIndex ? optionIndex : p))
                            )
                          }
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </>
            ) : null}

            {stepIndex === spellStepIndex && klass && slots ? (
              <>
                <div className={styles.detailRow}>
                  <Badge tone="purple">1st-level slots at level 1: {slots[1]}</Badge>
                  <Badge tone="teal">
                    Spellcasting: {ABILITY_LABEL[klass.spellcastingAbility!]}
                  </Badge>
                  <Badge>{chosenSpells.length} selected</Badge>
                </div>
                <div className={styles.spellScroll}>
                  {[
                    { label: "Cantrips", spells: cantrips },
                    { label: "1st-level spells", spells: firstLevelSpells },
                  ].map((group) => (
                    <div key={group.label} className={styles.group}>
                      <span className={styles.groupLabel}>{group.label}</span>
                      <div className={styles.cardGrid}>
                        {group.spells.map((spell) => (
                          <ChoiceCard
                            key={spell.name}
                            title={spell.name}
                            meta={`${spell.school} · ${formatRange(spell.range)}${spell.concentration ? " · conc." : ""}`}
                            selected={chosenSpells.some((s) => s.name === spell.name)}
                            onClick={() => toggleSpell(spell.name, spell.level)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {stepIndex === reviewStepIndex && raceChosen && klass && finalScores ? (
              <ul className={styles.summaryList}>
                <li className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>Name</span>
                  <span className={styles.summaryValue}>{name.trim()}</span>
                </li>
                <li className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>Race</span>
                  <span className={styles.summaryValue} data-testid="wizard-summary-race">
                    {resolvedRaceName}
                  </span>
                </li>
                <li className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>Class</span>
                  <span className={styles.summaryValue}>{klass.name} (level 1)</span>
                </li>
                <li className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>Abilities</span>
                  <span className={styles.summaryValue}>
                    {ABILITIES.map(
                      (ability) =>
                        `${ABILITY_LABEL[ability].slice(0, 3).toUpperCase()} ${finalScores[ability]} (${formatModifier(abilityModifier(finalScores[ability]))})`
                    ).join(" · ")}
                  </span>
                </li>
                <li className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>Hit points</span>
                  <span className={styles.summaryValue}>{maxHp}</span>
                </li>
                <li className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>Armor class</span>
                  <span className={styles.summaryValue}>{armorClass}</span>
                </li>
                <li className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>Speed</span>
                  <span className={styles.summaryValue}>{speed} ft</span>
                </li>
                <li className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>Vision</span>
                  <span className={styles.summaryValue} data-testid="wizard-vision">
                    {darkvisionFeet !== null ? `Darkvision ${darkvisionFeet} ft` : "Normal vision"}
                  </span>
                </li>
                <li className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>Saving throws</span>
                  <span className={styles.summaryValue}>
                    {klass.savingThrowProficiencies
                      .map(
                        (ability) =>
                          `${ABILITY_LABEL[ability]} ${formatModifier(savingThrowBonus(ability, finalScores, 1, true))}`
                      )
                      .join(" · ")}
                  </span>
                </li>
                <li className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>Inventory</span>
                  <span className={styles.summaryValue}>
                    {inventory.map((item) => item.name).join(", ") || "—"}
                  </span>
                </li>
                {isCaster ? (
                  <li className={styles.summaryRow}>
                    <span className={styles.summaryLabel}>Spells</span>
                    <span className={styles.summaryValue}>
                      {chosenSpells.map((s) => s.name).join(", ") || "None selected"}
                    </span>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        </Panel>

        {saveError ? <p className={styles.footerError}>{saveError}</p> : null}

        <div className={styles.footerNav}>
          <Button
            variant="ghost"
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={stepIndex === 0 || saving}
          >
            Back
          </Button>
          {stepIndex < reviewStepIndex ? (
            <Button onClick={() => setStepIndex((i) => i + 1)} disabled={!stepIsValid(stepIndex)}>
              Next
            </Button>
          ) : (
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? "Creating…" : "Create character"}
            </Button>
          )}
        </div>
      </main>
    </div>
  );
}
