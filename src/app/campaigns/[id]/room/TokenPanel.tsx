"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Button, TextInput, type BadgeTone } from "@/ui-components";
import {
  TOKEN_ALLEGIANCES,
  type Character,
  type MapToken,
  type MonsterStatBlock,
  type TokenAllegiance,
} from "@/data-access";
import styles from "./room.module.css";

/** A pending "click a cell to finish this" token action — the Game Room
 * passes it to the scene as the signal to turn on cell raycasting.
 * "place-monster" is the Prompt 61 quick-add: an NPC placement whose token
 * links the stat block (npcName carries the block's name, keeping every
 * npc_name display path unchanged), armed from the MonsterPanel.
 * `allegiance` (Weather & Enemies C5) carries the stat block's own
 * `default_allegiance` at arm time — 'hostile' for every hand-authored
 * block (unchanged from before this field existed), or whatever a copied
 * monster_templates row's default_allegiance was (e.g. 'neutral' for a
 * Trader/Guard/High Guard) — so handleCellClick can hand it to
 * placeNpcToken instead of that call's own hardcoded 'hostile'. */
export type TokenArm =
  | { kind: "place-character"; characterId: string; label: string }
  | { kind: "place-npc"; npcName: string }
  | { kind: "place-monster"; statBlockId: string; npcName: string; allegiance: TokenAllegiance }
  | { kind: "move"; tokenId: string; label: string };

const ALLEGIANCE_TONE: Record<TokenAllegiance, BadgeTone> = {
  party: "teal",
  hostile: "red",
  neutral: "orange",
};

function armedLabel(armed: TokenArm): string {
  switch (armed.kind) {
    case "place-character":
      return `Click a map cell to place ${armed.label}`;
    case "place-npc":
    case "place-monster":
      return `Click a map cell to place ${armed.npcName}`;
    case "move":
      return `Click a map cell to move ${armed.label}`;
  }
}

/**
 * The Game Room's token side panel: place-your-character for players, plus
 * full place/move/remove/allegiance/NPC control for the DM. Mirrors
 * MapPanel's DM-vs-player gating pattern on the opposite side of the room.
 *
 * NPC HP outside combat: a stat-blocked NPC token's row also shows its own
 * current_hp/max_hp (defaulting current_hp to the stat block's own max_hp
 * when null, the "null means full" convention 0089 established) and, for
 * the DM, a damage/heal control — CombatPanel.tsx's own hp-amount-input-/
 * apply-damage-/apply-heal- shape, applied to the token directly via
 * applyNpcTokenHpDelta (mapTokens.ts) rather than combat_combatants. This
 * is the ONLY place NPC HP was ever visible/adjustable before: CombatPanel's
 * own equivalent control only ever reaches a token once it's seated as a
 * combatant in an active encounter, which is why activeCombatantTokenIds
 * suppresses THIS control for such a token — CombatPanel already owns that
 * case, keeping combat_combatants.npc_current_hp in sync; offering a second
 * write path here would let the two counters drift apart. The read-only
 * display still shows regardless, since map_tokens.current_hp stays
 * accurate either way. A bare unstatted NPC (no monster_stat_block_id) gets
 * neither, exactly like CombatPanel's own existing scope limit.
 */
export function TokenPanel({
  campaignId,
  isDM,
  currentUserId,
  characters,
  tokens,
  statBlocks,
  activeCombatantTokenIds,
  armed,
  busy,
  error,
  onArm,
  onCancel,
  onRemove,
  onSetAllegiance,
  onApplyNpcHp,
}: {
  campaignId: string;
  isDM: boolean;
  currentUserId: string;
  /** RLS-filtered per viewer: a player's own characters, or all for the DM. */
  characters: Character[];
  tokens: MapToken[];
  /** Member-readable (0038): the campaign's monster stat blocks, resolving
   * a stat-blocked NPC token's own HP ceiling — the same statBlocks prop
   * CombatPanel already receives for the identical purpose. */
  statBlocks: MonsterStatBlock[];
  /** token_id of every combatant currently seated in the campaign's active
   * encounter (if any) — read-only from GameRoom's existing combat state.
   * Such a token's damage/heal control is CombatPanel's to own; this panel
   * suppresses its own for it (display only) so the two HP counters never
   * get two independent write paths. */
  activeCombatantTokenIds: ReadonlySet<string>;
  armed: TokenArm | null;
  busy: boolean;
  error: string | null;
  onArm: (arm: TokenArm) => void;
  onCancel: () => void;
  onRemove: (token: MapToken) => void;
  onSetAllegiance: (token: MapToken, allegiance: TokenAllegiance) => void;
  /** Negative = damage, positive = heal, applied straight to the token's
   * own current_hp via applyNpcTokenHpDelta. Only ever called for a
   * stat-blocked NPC token not in activeCombatantTokenIds — see this
   * component's own doc comment. */
  onApplyNpcHp: (token: MapToken, delta: number) => void;
}) {
  const [npcName, setNpcName] = useState("");
  const [hpAmounts, setHpAmounts] = useState<Record<string, string>>({});

  const characterById = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
  );
  const statBlockById = useMemo(
    () => new Map(statBlocks.map((statBlock) => [statBlock.id, statBlock])),
    [statBlocks]
  );
  const placedCharacterIds = useMemo(
    () => new Set(tokens.flatMap((token) => (token.character_id ? [token.character_id] : []))),
    [tokens]
  );
  const placeable = characters.filter(
    (character) =>
      !placedCharacterIds.has(character.id) && (isDM || character.owner_id === currentUserId)
  );

  function tokenLabel(token: MapToken): string {
    if (token.npc_name) return token.npc_name;
    // A token for a character the viewer can't read (another player's PC —
    // characters RLS is owner-or-DM) still renders and lists, just without
    // its name.
    return characterById.get(token.character_id ?? "")?.name ?? "Party member";
  }

  function canControl(token: MapToken): boolean {
    if (isDM) return true;
    const character = token.character_id ? characterById.get(token.character_id) : null;
    return character?.owner_id === currentUserId;
  }

  /** The Character behind a PC token, only when the viewer can actually
   * read it — `characters` is already RLS-filtered per viewer (see above),
   * so a hit here means a sheet link is safe to render. NPC tokens
   * (character_id null) never resolve. */
  function characterForToken(token: MapToken): Character | null {
    return token.character_id ? (characterById.get(token.character_id) ?? null) : null;
  }

  /** A stat-blocked NPC token's HP, current defaulting to the stat block's
   * own max_hp when the token's own current_hp is still null (0089's "null
   * means full" convention) — CombatPanel's own combatantHp shape, applied
   * to a token instead of a combatant. null for a PC token, a bare
   * unstatted NPC, or a stale monster_stat_block_id (deleted stat block). */
  function tokenHp(token: MapToken): { current: number; max: number } | null {
    if (!token.monster_stat_block_id) return null;
    const statBlock = statBlockById.get(token.monster_stat_block_id);
    if (!statBlock) return null;
    return { current: token.current_hp ?? statBlock.max_hp, max: statBlock.max_hp };
  }

  // Always a positive amount — direction comes from the Damage/Heal button
  // pressed, never from the DM typing a sign. Mirrors CombatPanel's own
  // parsedHpAmount exactly.
  function parsedHpAmount(token: MapToken): number | null {
    const value = Number((hpAmounts[token.id] ?? "").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  return (
    <aside className={styles.tokenPanel} data-testid="token-panel">
      <span className={styles.panelLabel}>Tokens</span>

      {armed ? (
        <div className={styles.armedHint} data-testid="token-armed-hint">
          <span>{armedLabel(armed)}</span>
          <Button size="sm" variant="ghost" onClick={onCancel} data-testid="cancel-arm">
            Cancel
          </Button>
        </div>
      ) : null}

      {placeable.length > 0 ? (
        <div className={styles.tokenSection}>
          {placeable.map((character) => (
            <div key={character.id} className={styles.objectHeader}>
              <span className={styles.objectName}>{character.name}</span>
              <Link
                href={`/campaigns/${campaignId}/characters/${character.id}`}
                className={styles.characterLink}
                data-testid={`view-sheet-placeable-${character.id}`}
              >
                View sheet
              </Link>
              <Button
                size="sm"
                variant="teal"
                disabled={busy}
                onClick={() =>
                  onArm({ kind: "place-character", characterId: character.id, label: character.name })
                }
                data-testid={`place-character-${character.id}`}
              >
                Place on table
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {tokens.length === 0 ? (
        <p className={styles.hint}>No tokens on the table yet.</p>
      ) : (
        <div className={styles.tokenSection}>
          {tokens.map((token) => {
            const owner = characterForToken(token);
            return (
            <div key={token.id} className={styles.objectRow} data-testid={`token-${token.id}`}>
              <div className={styles.objectHeader}>
                <span className={styles.objectName}>{tokenLabel(token)}</span>
                <Badge tone={ALLEGIANCE_TONE[token.allegiance]} data-testid={`token-allegiance-${token.id}`}>
                  {token.allegiance}
                </Badge>
                <span className={styles.tokenPos} data-testid={`token-pos-${token.id}`}>
                  ({token.x}, {token.y})
                </span>
                {tokenHp(token) ? (
                  <span className={styles.hpValue} data-testid={`token-hp-${token.id}`}>
                    {tokenHp(token)?.current}/{tokenHp(token)?.max} HP
                  </span>
                ) : null}
                {owner ? (
                  <Link
                    href={`/campaigns/${campaignId}/characters/${owner.id}`}
                    className={styles.characterLink}
                    data-testid={`view-sheet-${token.id}`}
                  >
                    View sheet
                  </Link>
                ) : null}
              </div>
              {canControl(token) ? (
                <div className={styles.objectHeader}>
                  <Button
                    size="sm"
                    variant="teal"
                    disabled={busy}
                    onClick={() => onArm({ kind: "move", tokenId: token.id, label: tokenLabel(token) })}
                    data-testid={`move-token-${token.id}`}
                  >
                    Move
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() => onRemove(token)}
                    data-testid={`remove-token-${token.id}`}
                  >
                    Remove
                  </Button>
                </div>
              ) : null}
              {isDM ? (
                <div className={styles.objectHeader}>
                  {TOKEN_ALLEGIANCES.map((allegiance) => (
                    <Button
                      key={allegiance}
                      size="sm"
                      variant={token.allegiance === allegiance ? "teal" : "ghost"}
                      disabled={busy || token.allegiance === allegiance}
                      onClick={() => onSetAllegiance(token, allegiance)}
                      data-testid={`set-allegiance-${token.id}-${allegiance}`}
                    >
                      {allegiance}
                    </Button>
                  ))}
                </div>
              ) : null}
              {isDM && tokenHp(token) && !activeCombatantTokenIds.has(token.id) ? (
                <div className={styles.objectHeader} data-testid={`hp-controls-${token.id}`}>
                  <input
                    type="number"
                    min={1}
                    className={styles.initiativeInput}
                    aria-label={`Damage or healing amount for ${tokenLabel(token)}`}
                    placeholder="Amount"
                    value={hpAmounts[token.id] ?? ""}
                    onChange={(event) =>
                      setHpAmounts((prev) => ({ ...prev, [token.id]: event.target.value }))
                    }
                    data-testid={`hp-amount-input-${token.id}`}
                  />
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy || parsedHpAmount(token) === null}
                    onClick={() => {
                      const amount = parsedHpAmount(token);
                      if (amount !== null) onApplyNpcHp(token, -amount);
                    }}
                    data-testid={`apply-damage-${token.id}`}
                  >
                    Damage
                  </Button>
                  <Button
                    size="sm"
                    variant="teal"
                    disabled={busy || parsedHpAmount(token) === null}
                    onClick={() => {
                      const amount = parsedHpAmount(token);
                      if (amount !== null) onApplyNpcHp(token, amount);
                    }}
                    data-testid={`apply-heal-${token.id}`}
                  >
                    Heal
                  </Button>
                </div>
              ) : null}
            </div>
            );
          })}
        </div>
      )}

      {isDM ? (
        <div className={styles.tokenSection}>
          <TextInput
            label="NPC token"
            value={npcName}
            onChange={(event) => setNpcName(event.target.value)}
            placeholder="Goblin, cultist, mysterious figure…"
            data-testid="npc-name-input"
          />
          <Button
            size="sm"
            variant="accent"
            disabled={busy || npcName.trim().length === 0}
            onClick={() => {
              onArm({ kind: "place-npc", npcName: npcName.trim() });
              setNpcName("");
            }}
            data-testid="place-npc-button"
          >
            Place NPC
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className={styles.errorText} data-testid="token-error">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
