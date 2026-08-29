"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Button, TextInput, type BadgeTone } from "@/ui-components";
import { TOKEN_ALLEGIANCES, type Character, type MapToken, type TokenAllegiance } from "@/data-access";
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
 */
export function TokenPanel({
  campaignId,
  isDM,
  currentUserId,
  characters,
  tokens,
  armed,
  busy,
  error,
  onArm,
  onCancel,
  onRemove,
  onSetAllegiance,
}: {
  campaignId: string;
  isDM: boolean;
  currentUserId: string;
  /** RLS-filtered per viewer: a player's own characters, or all for the DM. */
  characters: Character[];
  tokens: MapToken[];
  armed: TokenArm | null;
  busy: boolean;
  error: string | null;
  onArm: (arm: TokenArm) => void;
  onCancel: () => void;
  onRemove: (token: MapToken) => void;
  onSetAllegiance: (token: MapToken, allegiance: TokenAllegiance) => void;
}) {
  const [npcName, setNpcName] = useState("");

  const characterById = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
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
