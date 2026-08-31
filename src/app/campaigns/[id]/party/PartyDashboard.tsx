"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  CONDITIONS,
  CONDITION_BY_KEY,
  EXHAUSTION_KEY,
  MAX_EXHAUSTION_LEVEL,
  levelForXp,
  xpThresholdForLevel,
  xpToNextLevel,
  type AdvantageMode,
  type ConditionKey,
} from "@/rules-engine";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import {
  applyCharacterCondition,
  applyCharacterExhaustionDelta,
  applyCondition,
  applyExhaustionDelta,
  awardXp,
  getActiveCombatEncounter,
  getActiveCombatantForCharacter,
  listCharacterConditions,
  listCombatCombatants,
  listCombatantConditions,
  removeCharacterCondition,
  removeCondition,
  setPendingRollMode,
  subscribeToCampaignCharacterChanges,
  subscribeToCharacterConditionChanges,
  subscribeToCombatantConditionChanges,
  type Character,
  type CharacterCondition,
  type SupabaseClient,
} from "@/data-access";
import { Badge, Button } from "@/ui-components";
import { LevelUpWizard } from "../LevelUpWizard";
import styles from "./party.module.css";

/** A combat-sourced condition already resolved to its character — the
 * server page's initial load and the client refetch both produce this. */
interface CombatConditionByCharacter {
  character_id: string;
  condition_key: string;
  level: number | null;
}

const MODES: AdvantageMode[] = ["normal", "advantage", "disadvantage"];
const MODE_LABEL: Record<AdvantageMode, string> = {
  normal: "Normal",
  advantage: "Advantage",
  disadvantage: "Disadvantage",
};
const QUICK_AWARDS = [25, 100, 500];

/** Defensive against the not-yet-applied 0101 migration: the two new
 * columns are simply absent from the row until then. */
function xpOf(character: Character): number {
  return typeof character.xp === "number" ? character.xp : 0;
}

function modeOf(character: Character): AdvantageMode {
  return character.pending_roll_mode === "advantage" ||
    character.pending_roll_mode === "disadvantage"
    ? character.pending_roll_mode
    : "normal";
}

/**
 * The DM's live party console. Design intent: one card per character,
 * every card the same fixed scan order (vitals bars up top, then
 * conditions, then the two grant controls), so mid-session the DM's eye
 * can sweep the grid the way they'd sweep initiative — no drilling in
 * unless they want the full sheet, which is one click (the EXISTING sheet
 * route, never a rebuilt view).
 *
 * The two design forks this feature resolved, and why:
 *
 * XP crossing an SRD threshold is SUGGEST-THEN-CONFIRM, never silent
 * auto-apply: (a) the level-up applies the SRD average-hit-die HP gain,
 * which needs a cataloged class — an unknown/homebrew class has no hit
 * die, so a silent path would have to invent one; (b) tables commonly
 * award XP mid-session but take levels between scenes — silently mutating
 * level AND HP mid-combat would surprise the player at the worst moment;
 * (c) a mistaken award (fat-fingered amount) would compound into a wrong
 * level before the DM noticed. The suggestion is unmissable (a glowing
 * confirm row on the card) but the DM stays in control. Each confirm
 * advances exactly ONE level — a huge award crossing several thresholds
 * just leaves the row visible for the next confirm.
 *
 * Conditions dual-write: applying writes character_conditions ALWAYS (so
 * the condition survives combat starting/ending) and mirrors onto the
 * live combatant row when one exists (so in-combat mechanics — which read
 * combatant_conditions only — feel it immediately); removal clears both
 * sides. Every display surface merges the two sources by key, so the
 * dual-write can never double-list. A condition applied from the COMBAT
 * panel remains combat-scoped (dies with the encounter) — that asymmetry
 * is deliberate: the combat panel manages the fight, this page manages
 * the character.
 */
export function PartyDashboard({
  campaignId,
  initialCharacters,
  initialCharacterConditions,
  initialCombatConditions,
  ownerNames,
}: {
  campaignId: string;
  initialCharacters: Character[];
  initialCharacterConditions: CharacterCondition[];
  initialCombatConditions: CombatConditionByCharacter[];
  ownerNames: Record<string, string | null>;
}) {
  const [characters, setCharacters] = useState(initialCharacters);
  const [characterConditions, setCharacterConditions] = useState(initialCharacterConditions);
  const [combatConditions, setCombatConditions] = useState(initialCombatConditions);
  const [awardDrafts, setAwardDrafts] = useState<Record<string, string>>({});
  const [conditionPicks, setConditionPicks] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [notices, setNotices] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // The refetch helpers read the CURRENT roster ids without resubscribing
  // per character-list change — the sheet's currentHpRef arrangement.
  const characterIdsRef = useRef(initialCharacters.map((character) => character.id));
  useEffect(() => {
    characterIdsRef.current = characters.map((character) => character.id);
  }, [characters]);

  // Live roster: HP swings from the Game Room, XP awards and grants from
  // another DM tab, condition-driven updated_at bumps — all land through
  // the campaign-wide characters subscription (0028's publication).
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    return subscribeToCampaignCharacterChanges(supabase, campaignId, (row) => {
      setCharacters((current) =>
        current.map((existing) => (existing.id === row.id ? row : existing))
      );
    });
  }, [campaignId]);

  // Character-keyed conditions: poke-then-refetch, latest-wins sequencing —
  // the sheet's exact arrangement, roster-wide.
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    let seq = 0;
    return subscribeToCharacterConditionChanges(supabase, () => {
      const current = ++seq;
      void (async () => {
        try {
          const rows = await listCharacterConditions(supabase, characterIdsRef.current);
          if (current === seq) setCharacterConditions(rows);
        } catch {
          // A dropped refetch leaves the previous badges; the next poke retries.
        }
      })();
    });
  }, []);

  // Combat-scoped conditions: each poke re-resolves the active encounter
  // rather than caching it (it may have started or ended since page load) —
  // the sheet's refreshCombat reasoning, roster-wide.
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    let seq = 0;
    return subscribeToCombatantConditionChanges(supabase, () => {
      const current = ++seq;
      void (async () => {
        try {
          const rows = await fetchCombatConditions(supabase, campaignId);
          if (current === seq) setCombatConditions(rows);
        } catch {
          // Same dropped-refetch tolerance as above.
        }
      })();
    });
  }, [campaignId]);

  function setCardError(characterId: string, message: string | null) {
    setErrors((current) => ({ ...current, [characterId]: message }));
    if (message !== null) setNotices((current) => ({ ...current, [characterId]: null }));
  }

  function setCardNotice(characterId: string, message: string | null) {
    setNotices((current) => ({ ...current, [characterId]: message }));
    if (message !== null) setErrors((current) => ({ ...current, [characterId]: null }));
  }

  function replaceCharacter(row: Character) {
    setCharacters((current) =>
      current.map((existing) => (existing.id === row.id ? row : existing))
    );
  }

  /** One in-flight mutation per card: the whole card's controls disable
   * together, and errors/notices land in that card's own footer line. */
  async function run(characterId: string, action: () => Promise<void>) {
    if (busy[characterId]) return;
    setBusy((current) => ({ ...current, [characterId]: true }));
    setCardError(characterId, null);
    try {
      await action();
    } catch (err) {
      setCardError(
        characterId,
        err instanceof Error ? err.message : "That change could not be saved."
      );
    } finally {
      setBusy((current) => ({ ...current, [characterId]: false }));
    }
  }

  async function award(character: Character, amount: number) {
    await run(character.id, async () => {
      const updated = await awardXp(createBrowserSupabaseClient(), character.id, amount);
      replaceCharacter(updated);
      setAwardDrafts((current) => ({ ...current, [character.id]: "" }));
      const suggested = levelForXp(xpOf(updated));
      setCardNotice(
        character.id,
        suggested > updated.level
          ? `+${amount} XP — ${updated.name} has reached the level ${suggested} threshold. Confirm the level-up below.`
          : `+${amount} XP (now ${xpOf(updated).toLocaleString()}).`
      );
    });
  }

  // The suggest-then-confirm resolution of a crossed threshold used to run
  // its own inline math (one level, SRD average hit-die + CON gain, one
  // updateCharacter call) — that's now the guided LevelUpWizard, shared
  // with the character sheet's own "Level up" button (see that
  // component's doc comment for why one shared flow instead of two). This
  // page just tracks WHICH character's wizard is open (one at a time — a
  // DM confirming several level-ups in a row opens, completes, and closes
  // it per character) and reacts to its result the same way the sheet
  // does: replace the row, show the same-shaped confirmation notice.
  const [levelUpCharacter, setLevelUpCharacter] = useState<Character | null>(null);

  function handleLevelUpApplied(updated: Character, hpGain: number) {
    replaceCharacter(updated);
    setCardNotice(
      updated.id,
      `${updated.name} is now level ${updated.level} — hit points +${hpGain} (${updated.current_hp} / ${updated.max_hp}).`
    );
  }

  async function applyPickedCondition(character: Character) {
    const key = conditionPicks[character.id];
    if (!key || !CONDITION_BY_KEY.has(key as ConditionKey)) return;
    await run(character.id, async () => {
      const supabase = createBrowserSupabaseClient();
      // Persistent side first — the source of truth that survives combat.
      await applyCharacterCondition(supabase, character.id, key as ConditionKey);
      // Combat mirror, so in-combat mechanics feel it immediately (see the
      // component doc comment). Best-effort: the persistent apply already
      // succeeded, and the merged display shows the condition either way.
      try {
        const combatant = await getActiveCombatantForCharacter(supabase, campaignId, character.id);
        if (combatant) await applyCondition(supabase, combatant.id, key as ConditionKey);
      } catch {
        // The badge is already right; the combat panel catches up when the
        // DM touches it there.
      }
      const refreshed = await listCharacterConditions(supabase, [character.id]);
      setCharacterConditions((current) => [
        ...current.filter((row) => row.character_id !== character.id),
        ...refreshed,
      ]);
      setConditionPicks((current) => ({ ...current, [character.id]: "" }));
    });
  }

  async function removeConditionEverywhere(character: Character, key: string) {
    await run(character.id, async () => {
      const supabase = createBrowserSupabaseClient();
      if (key === EXHAUSTION_KEY) {
        // Exhaustion "remove" clears the whole track on both sides — the
        // RPC clamps at 0 and deletes the row.
        await applyCharacterExhaustionDelta(supabase, character.id, -MAX_EXHAUSTION_LEVEL);
      } else {
        await removeCharacterCondition(supabase, character.id, key as ConditionKey);
      }
      try {
        const combatant = await getActiveCombatantForCharacter(supabase, campaignId, character.id);
        if (combatant) {
          if (key === EXHAUSTION_KEY) {
            await applyExhaustionDelta(supabase, combatant.id, -MAX_EXHAUSTION_LEVEL);
          } else {
            await removeCondition(supabase, combatant.id, key as ConditionKey);
          }
        }
      } catch {
        // Combat mirror is best-effort, same as apply.
      }
      const refreshed = await listCharacterConditions(supabase, [character.id]);
      setCharacterConditions((current) => [
        ...current.filter((row) => row.character_id !== character.id),
        ...refreshed,
      ]);
      setCombatConditions((current) =>
        current.filter(
          (row) => !(row.character_id === character.id && row.condition_key === key)
        )
      );
    });
  }

  async function stepExhaustion(character: Character, delta: number) {
    await run(character.id, async () => {
      const supabase = createBrowserSupabaseClient();
      await applyCharacterExhaustionDelta(supabase, character.id, delta);
      try {
        const combatant = await getActiveCombatantForCharacter(supabase, campaignId, character.id);
        if (combatant) await applyExhaustionDelta(supabase, combatant.id, delta);
      } catch {
        // Best-effort combat mirror.
      }
      const refreshed = await listCharacterConditions(supabase, [character.id]);
      setCharacterConditions((current) => [
        ...current.filter((row) => row.character_id !== character.id),
        ...refreshed,
      ]);
    });
  }

  async function grantMode(character: Character, mode: AdvantageMode) {
    if (modeOf(character) === mode) return;
    await run(character.id, async () => {
      const updated = await setPendingRollMode(createBrowserSupabaseClient(), character.id, mode);
      replaceCharacter(updated);
      setCardNotice(
        character.id,
        mode === "normal"
          ? "Next-roll grant cleared."
          : `${updated.name}'s next roll has ${mode} — any surface, then it clears itself.`
      );
    });
  }

  /** The sheet's merge rule, per character: union both condition sources
   * by key; exhaustion shows the higher level. */
  function mergedConditionsFor(characterId: string) {
    const byKey = new Map<string, { condition_key: string; level: number | null }>();
    const rows = [
      ...combatConditions.filter((row) => row.character_id === characterId),
      ...characterConditions.filter((row) => row.character_id === characterId),
    ];
    for (const row of rows) {
      const existing = byKey.get(row.condition_key);
      if (!existing) {
        byKey.set(row.condition_key, { condition_key: row.condition_key, level: row.level });
      } else if (row.level !== null && (existing.level === null || row.level > existing.level)) {
        existing.level = row.level;
      }
    }
    return [...byKey.values()];
  }

  if (characters.length === 0) {
    return (
      <p className={styles.emptyHint} data-testid="party-dashboard-empty">
        No characters in this campaign yet — the dashboard fills in as players create them.
      </p>
    );
  }

  return (
    <>
      <section className={styles.grid} data-testid="party-dashboard">
      {characters.map((character) => {
        const merged = mergedConditionsFor(character.id);
        const exhaustion = merged.find((row) => row.condition_key === EXHAUSTION_KEY);
        const xp = xpOf(character);
        const next = xpToNextLevel(xp, character.level);
        const bandStart = xpThresholdForLevel(character.level);
        const bandPct = next
          ? Math.min(100, Math.max(0, ((xp - bandStart) / (next.threshold - bandStart)) * 100))
          : 100;
        const hpPct =
          character.max_hp > 0
            ? Math.min(100, Math.max(0, (character.current_hp / character.max_hp) * 100))
            : 0;
        const hpClass =
          hpPct <= 25 ? styles.hpFillCritical : hpPct <= 50 ? styles.hpFillHurt : styles.hpFillOk;
        const suggestedLevel = levelForXp(xp);
        const levelUpAvailable = suggestedLevel > character.level && character.level < 20;
        const cardBusy = busy[character.id] === true;
        const mode = modeOf(character);
        const ownerName = ownerNames[character.owner_id] ?? null;
        const awardDraft = awardDrafts[character.id] ?? "";
        const awardValue = Number(awardDraft);
        const awardValid = Number.isInteger(awardValue) && awardValue !== 0;

        return (
          <article
            key={character.id}
            className={styles.card}
            data-testid={`party-card-${character.id}`}
          >
            <header className={styles.cardHeader}>
              <div className={styles.cardTitleBlock}>
                <Link
                  href={`/campaigns/${campaignId}/characters/${character.id}`}
                  className={styles.cardName}
                  data-testid={`party-sheet-link-${character.id}`}
                >
                  {character.name}
                </Link>
                <span className={styles.cardMeta}>
                  <Badge tone="purple">{character.race}</Badge>
                  <Badge tone="teal">
                    {character.class} {character.level}
                  </Badge>
                  {ownerName ? <span className={styles.ownerName}>{ownerName}</span> : null}
                </span>
              </div>
              <Link
                href={`/campaigns/${campaignId}/characters/${character.id}`}
                className={styles.sheetLink}
              >
                Full sheet →
              </Link>
            </header>

            <div className={styles.statRow}>
              <span className={styles.statLabel}>HP</span>
              <span className={styles.track} aria-hidden="true">
                <span className={hpClass} style={{ width: `${hpPct}%` }} />
              </span>
              <span className={styles.statValue} data-testid={`party-hp-${character.id}`}>
                {character.current_hp} / {character.max_hp}
              </span>
              {character.current_hp === 0 ? (
                character.is_dead ? (
                  <Badge tone="red">Dead</Badge>
                ) : character.is_stable ? (
                  <Badge tone="teal">Stable</Badge>
                ) : (
                  <Badge tone="red" pulse>
                    Dying
                  </Badge>
                )
              ) : null}
            </div>

            <div className={styles.statRow}>
              <span className={styles.statLabel}>XP</span>
              <span className={styles.track} aria-hidden="true">
                <span className={styles.xpFill} style={{ width: `${bandPct}%` }} />
              </span>
              <span className={styles.statValue} data-testid={`party-xp-${character.id}`}>
                {xp.toLocaleString()}
                {next
                  ? ` · ${next.remaining.toLocaleString()} to L${next.nextLevel}`
                  : " · max level"}
              </span>
            </div>

            <div className={styles.awardRow}>
              {QUICK_AWARDS.map((amount) => (
                <Button
                  key={amount}
                  size="sm"
                  variant="ghost"
                  disabled={cardBusy}
                  onClick={() => void award(character, amount)}
                  data-testid={`party-award-${amount}-${character.id}`}
                >
                  +{amount}
                </Button>
              ))}
              <input
                className={styles.awardInput}
                type="number"
                placeholder="XP"
                value={awardDraft}
                onChange={(e) =>
                  setAwardDrafts((current) => ({ ...current, [character.id]: e.target.value }))
                }
                aria-label={`Custom XP amount for ${character.name}`}
                data-testid={`party-award-input-${character.id}`}
              />
              <Button
                size="sm"
                variant="teal"
                disabled={cardBusy || !awardValid}
                onClick={() => void award(character, awardValue)}
                data-testid={`party-award-button-${character.id}`}
              >
                Award
              </Button>
            </div>

            {levelUpAvailable ? (
              <div className={styles.levelUpRow} data-testid={`party-levelup-row-${character.id}`}>
                <span className={styles.levelUpText}>
                  Level {Math.min(suggestedLevel, character.level + 1)} threshold reached
                </span>
                <Button
                  size="sm"
                  variant="accent"
                  disabled={cardBusy}
                  onClick={() => setLevelUpCharacter(character)}
                  data-testid={`party-levelup-${character.id}`}
                >
                  Confirm level {character.level + 1}
                </Button>
              </div>
            ) : null}

            <div className={styles.conditionsBlock}>
              <span className={styles.statLabel}>Conditions</span>
              <span className={styles.conditionBadges}>
                {merged.length === 0 ? (
                  <span
                    className={styles.noneText}
                    data-testid={`party-conditions-empty-${character.id}`}
                  >
                    None
                  </span>
                ) : (
                  merged.map((row) => {
                    const isExhaustion = row.condition_key === EXHAUSTION_KEY;
                    const label = isExhaustion
                      ? `Exhaustion ${row.level ?? 1}`
                      : (CONDITION_BY_KEY.get(row.condition_key as ConditionKey)?.name ??
                        row.condition_key);
                    return (
                      <span
                        key={row.condition_key}
                        className={styles.conditionChip}
                        data-testid={`party-condition-${row.condition_key}-${character.id}`}
                      >
                        {label}
                        <button
                          type="button"
                          className={styles.chipRemove}
                          disabled={cardBusy}
                          onClick={() => void removeConditionEverywhere(character, row.condition_key)}
                          aria-label={`Remove ${label} from ${character.name}`}
                          data-testid={`party-condition-remove-${row.condition_key}-${character.id}`}
                        >
                          ×
                        </button>
                      </span>
                    );
                  })
                )}
              </span>
              <span className={styles.conditionControls}>
                <select
                  className={styles.conditionSelect}
                  value={conditionPicks[character.id] ?? ""}
                  onChange={(e) =>
                    setConditionPicks((current) => ({
                      ...current,
                      [character.id]: e.target.value,
                    }))
                  }
                  aria-label={`Condition to apply to ${character.name}`}
                  data-testid={`party-condition-select-${character.id}`}
                >
                  <option value="">Condition…</option>
                  {CONDITIONS.map((definition) => (
                    <option key={definition.key} value={definition.key}>
                      {definition.name}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="teal"
                  disabled={cardBusy || !conditionPicks[character.id]}
                  onClick={() => void applyPickedCondition(character)}
                  data-testid={`party-condition-apply-${character.id}`}
                >
                  Apply
                </Button>
                <span className={styles.exhaustionControls}>
                  <span className={styles.exhaustionLabel}>
                    Exhaustion {exhaustion?.level ?? 0}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={cardBusy || !exhaustion}
                    onClick={() => void stepExhaustion(character, -1)}
                    aria-label={`Lower ${character.name}'s exhaustion`}
                    data-testid={`party-exhaustion-minus-${character.id}`}
                  >
                    −
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={cardBusy || (exhaustion?.level ?? 0) >= MAX_EXHAUSTION_LEVEL}
                    onClick={() => void stepExhaustion(character, 1)}
                    aria-label={`Raise ${character.name}'s exhaustion`}
                    data-testid={`party-exhaustion-plus-${character.id}`}
                  >
                    +
                  </Button>
                </span>
              </span>
            </div>

            <div className={styles.modeBlock}>
              <span className={styles.statLabel}>Next roll</span>
              <span
                className={styles.modeToggle}
                role="group"
                aria-label={`Next-roll mode for ${character.name}`}
              >
                {MODES.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    className={[
                      styles.modeButton,
                      candidate === mode ? styles.modeButtonActive : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-pressed={candidate === mode}
                    disabled={cardBusy}
                    onClick={() => void grantMode(character, candidate)}
                    data-testid={`party-mode-${candidate}-${character.id}`}
                  >
                    {MODE_LABEL[candidate]}
                  </button>
                ))}
              </span>
              {mode !== "normal" ? (
                <span className={styles.modeHint} data-testid={`party-mode-hint-${character.id}`}>
                  applies to the next roll anywhere, then clears
                </span>
              ) : null}
            </div>

            {errors[character.id] ? (
              <p
                className={styles.cardError}
                role="alert"
                data-testid={`party-error-${character.id}`}
              >
                {errors[character.id]}
              </p>
            ) : null}
            {notices[character.id] ? (
              <p className={styles.cardNotice} data-testid={`party-notice-${character.id}`}>
                {notices[character.id]}
              </p>
            ) : null}
          </article>
        );
      })}
      </section>
      {levelUpCharacter ? (
        <LevelUpWizard
          onClose={() => setLevelUpCharacter(null)}
          character={levelUpCharacter}
          onApplied={(updated, hpGain) => {
            handleLevelUpApplied(updated, hpGain);
            setLevelUpCharacter(null);
          }}
        />
      ) : null}
    </>
  );
}

/** Re-resolves the active encounter's conditions to per-character rows —
 * the server page's initial-load computation, repeated on every combat
 * condition poke (the encounter may have started or ended since load). */
async function fetchCombatConditions(
  supabase: SupabaseClient,
  campaignId: string
): Promise<CombatConditionByCharacter[]> {
  const encounter = await getActiveCombatEncounter(supabase, campaignId);
  if (!encounter) return [];
  const combatants = await listCombatCombatants(supabase, encounter.id);
  if (combatants.length === 0) return [];
  const rows = await listCombatantConditions(
    supabase,
    combatants.map((combatant) => combatant.id)
  );
  const characterIdByCombatant = new Map(
    combatants
      .filter((combatant) => combatant.character_id !== null)
      .map((combatant) => [combatant.id, combatant.character_id as string])
  );
  return rows.flatMap((row) => {
    const characterId = characterIdByCombatant.get(row.combatant_id);
    return characterId
      ? [{ character_id: characterId, condition_key: row.condition_key, level: row.level }]
      : [];
  });
}
