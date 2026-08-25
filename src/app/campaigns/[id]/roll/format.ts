import type {
  AttackResolution,
  D20RollBreakdown,
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

export function damageText(attack: AttackResolution): string | null {
  if (!attack.damage) return null;
  const dice = groupsText(attack.damage.groups, attack.damage.modifier);
  const doubled = attack.damage.doubled ? " (dice doubled)" : "";
  const applied = attack.applied ? ` — applied, target at ${attack.applied.newHp} HP` : "";
  return `Damage ${attack.damage.notation}${doubled}: ${dice} = ${attack.damage.total}${applied}`;
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
