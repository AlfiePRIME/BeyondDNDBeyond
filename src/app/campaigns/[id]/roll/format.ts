import type {
  AttackResolution,
  ConcentrationSaveResolution,
  D20RollBreakdown,
  DeathSaveResolution,
  RollBreakdown,
  RollLogEntry,
} from "@/data-access";
import type { RolledDiceGroup } from "@/rules-engine";

export function signed(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

/** "d20 12" for a normal roll; "d20 [3, 18] advantage → 18" otherwise —
 * both dice always shown so the log makes the adv/dis pick visible. */
export function d20Text(breakdown: D20RollBreakdown): string {
  if (breakdown.mode === "normal") return `d20 ${breakdown.d20Result}`;
  return `d20 [${breakdown.d20Rolls.join(", ")}] ${breakdown.mode} → ${breakdown.d20Result}`;
}

export function modifiersText(breakdown: D20RollBreakdown): string {
  return breakdown.modifiers
    .map((part) => `${signed(part.value)} (${part.label})`)
    .join(" ");
}

export function groupsText(groups: RolledDiceGroup[], modifier: number): string {
  const parts = groups.map(
    (group) =>
      `${group.sign === -1 ? "− " : ""}${group.count}d${group.sides} [${group.results.join(", ")}]`
  );
  if (modifier !== 0) parts.push(signed(modifier));
  return parts.join(" + ").replace(/\+ − /g, "− ");
}

export function attackOutcomeText(attack: AttackResolution): string {
  if (attack.natural20) return "Natural 20 — critical hit";
  if (attack.natural1) return "Natural 1 — miss";
  return attack.hit ? "Hit" : "Miss";
}

/** WHY the attack rolled with the mode it did (Prompt 59): every collected
 * advantage/disadvantage source, spelled out — "Advantage — target has
 * Blinded (advantage against)", "Disadvantage — target not perceived" —
 * and, when sources on BOTH sides existed, the cancellation stated plainly
 * rather than the roll silently looking unmodified. Null when nothing
 * contributed at all (a plain normal attack, or any pre-59 logged roll,
 * where the fields are simply absent — the damageText falsy-check
 * convention). */
export function advantageReasonText(attack: AttackResolution): string | null {
  const advantage = attack.advantageSources ?? [];
  const disadvantage = attack.disadvantageSources ?? [];
  if (advantage.length === 0 && disadvantage.length === 0) return null;
  if (advantage.length > 0 && disadvantage.length > 0) {
    return `Advantage and disadvantage canceled to a flat roll — advantage: ${advantage.join(
      ", "
    )}; disadvantage: ${disadvantage.join(", ")}`;
  }
  if (advantage.length > 0) return `Advantage — ${advantage.join(", ")}`;
  return `Disadvantage — ${disadvantage.join(", ")}`;
}

export function damageText(attack: AttackResolution): string | null {
  if (!attack.damage) return null;
  const dice = groupsText(attack.damage.groups, attack.damage.modifier);
  const doubled = attack.damage.doubled ? " (dice doubled)" : "";
  const applied = attack.applied ? ` — applied, target at ${attack.applied.newHp} HP` : "";
  // Damage on an already-0-HP target (Prompt 49) — falsy-checked rather
  // than compared, so pre-49 rolls (where the fields are absent) still
  // format cleanly.
  const deathState = attack.instantDeath
    ? " · instant death"
    : attack.deathSaveFailureAdded
      ? ` · +${attack.deathSaveFailureAdded} failed death save${attack.deathSaveFailureAdded > 1 ? "s" : ""}`
      : "";
  return `Damage ${attack.damage.notation}${doubled}: ${dice} = ${attack.damage.total}${applied}${deathState}`;
}

/** "Success (2/3)" / "Failure (1/3)" / the natural-1/20 and third-roll
 * outcomes — the death-save analogue of attackOutcomeText. Success vs
 * failure comes from the counted die (>= 10), the naturals and endpoints
 * from the resolution itself. */
export function deathSaveOutcomeText(
  deathSave: DeathSaveResolution,
  d20Result: number
): string {
  if (deathSave.recovers) return "Natural 20 — back up at 1 HP";
  if (deathSave.died) {
    return deathSave.natural1 ? "Natural 1 — two failures · dead" : "Third failure — dead";
  }
  if (deathSave.stabilized) return "Third success — stable";
  if (deathSave.natural1) return `Natural 1 — two failures (${deathSave.failuresAfter}/3)`;
  return d20Result >= 10
    ? `Success (${deathSave.successesAfter}/3)`
    : `Failure (${deathSave.failuresAfter}/3)`;
}

/** "Success (DC 10)" / "Failed, concentration broken (DC 14)" — the
 * concentration-save analogue of attackOutcomeText/deathSaveOutcomeText.
 * The verdict is stored, not re-derived: the resolution IS the record of
 * what the server compared. */
export function concentrationSaveOutcomeText(save: ConcentrationSaveResolution): string {
  return save.passed
    ? `Success (DC ${save.dc})`
    : `Failed, concentration broken (DC ${save.dc})`;
}

/** One-line headline for a log entry, e.g. "Perception check — 17" or
 * "Melee attack vs AC 15 — 18 · Hit". */
export function rollHeadline(entry: RollLogEntry): string {
  const breakdown = entry.breakdown as RollBreakdown;
  if (breakdown.type === "dice") return `${breakdown.notation} — ${entry.total}`;
  if (breakdown.attack) {
    return `${breakdown.label} vs AC ${breakdown.attack.targetAc}${
      breakdown.attack.targetName ? ` (${breakdown.attack.targetName})` : ""
    } — ${entry.total} · ${attackOutcomeText(breakdown.attack)}`;
  }
  if (breakdown.deathSave) {
    return `${breakdown.label} — ${entry.total} · ${deathSaveOutcomeText(breakdown.deathSave, breakdown.d20Result)}`;
  }
  if (breakdown.concentrationSave) {
    // The bare kind name, not breakdown.label — the label already carries
    // the DC, which the outcome text repeats.
    return `Concentration save — ${entry.total} · ${concentrationSaveOutcomeText(breakdown.concentrationSave)}`;
  }
  return `${breakdown.label} — ${entry.total}`;
}

/** The full breakdown line under the headline. */
export function rollDetail(entry: RollLogEntry): string {
  const breakdown = entry.breakdown as RollBreakdown;
  if (breakdown.type === "dice") {
    return `${groupsText(breakdown.groups, breakdown.modifier)} = ${entry.total}`;
  }
  const mods = modifiersText(breakdown);
  return `${d20Text(breakdown)}${mods ? ` ${mods}` : ""} = ${entry.total}`;
}
