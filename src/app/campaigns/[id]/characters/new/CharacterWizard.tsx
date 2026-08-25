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
  const [className, setClassName] = useState<string | null>(null);
  const [baseScores, setBaseScores] = useState(DEFAULT_BASE_SCORES);
  const [bonusPicks, setBonusPicks] = useState<(AbilityScore | "")[]>([]);
  const [equipmentPicks, setEquipmentPicks] = useState<number[]>([]);
  const [chosenSpells, setChosenSpells] = useState<KnownSpell[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const race = RACES.find((r) => r.name === raceName) ?? null;
  const subrace = race?.subraces?.find((s) => s.name === subraceName) ?? null;
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
    return out;
  }, [parsedBaseScores, increases, choiceIncreases, bonusPicks]);

  const racialBonus = (ability: AbilityScore): number =>
    increases
      .filter((inc) => inc.ability === ability)
      .reduce((sum, inc) => sum + inc.amount, 0) +
    choiceIncreases.reduce(
      (sum, inc, i) => (bonusPicks[i] === ability ? sum + inc.amount : sum),
      0
    );

  const inventory: InventoryItem[] = useMemo(() => {
    if (!equipment) return [];
    const items = [...equipment.fixed];
    equipment.choices.forEach((choice, i) => {
      const pick = equipmentPicks[i];
      if (pick !== undefined && pick >= 0) items.push(...choice.options[pick]);
    });
    return items.map((item) => ({ name: item, quantity: 1 }));
  }, [equipment, equipmentPicks]);

  const speed = subrace?.speedFeet ?? race?.speedFeet ?? 30;
  // Subrace overrides race where both define it — the speed precedence rule
  // exactly (e.g. a Drow's 120 ft over the Elf's 60 ft); null means normal
  // vision only. Stored on the character at creation, like speed.
  const darkvisionFeet = subrace?.darkvisionFeet ?? race?.darkvisionFeet ?? null;
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
    if (!race || !klass || !finalScores || maxHp === null || armorClass === null) return;
    setSaving(true);
    setSaveError(null);

    const supabase = createBrowserSupabaseClient();
    try {
      await createCharacter(supabase, {
        campaign_id: campaignId,
        owner_id: userId,
        name: name.trim(),
        race: subrace ? subrace.name : race.name,
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

            {stepIndex === 1 && race && klass ? (
              <>
                <p className={styles.detailText}>
                  Seeded with the standard array (15/14/13/12/10/8) — edit freely. Racial increases
                  from {subrace ? subrace.name : race.name} are applied to the final scores.
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
                    <span className={styles.groupLabel}>
                      {subrace ? subrace.name : race.name} bonus ability choices
                    </span>
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

            {stepIndex === reviewStepIndex && race && klass && finalScores ? (
              <ul className={styles.summaryList}>
                <li className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>Name</span>
                  <span className={styles.summaryValue}>{name.trim()}</span>
                </li>
                <li className={styles.summaryRow}>
                  <span className={styles.summaryLabel}>Race</span>
                  <span className={styles.summaryValue}>{subrace ? subrace.name : race.name}</span>
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
