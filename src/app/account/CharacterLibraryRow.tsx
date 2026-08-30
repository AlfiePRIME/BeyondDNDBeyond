"use client";

import { useState, useActionState } from "react";
import Link from "next/link";
import { Badge, Button, TextInput } from "@/ui-components";
import { renameCharacterAction, deleteCharacterAction } from "./actions";
import type { FormActionState } from "../actions";
import type { OwnedCharacter } from "@/data-access";
import styles from "./account.module.css";

const initialState: FormActionState = {};

/**
 * One owned character's row in the account page's "Character library" —
 * the CampaignManageRow shape exactly (an always-visible rename form, plus
 * a two-step delete confirm) for the identical reason: rename is
 * low-stakes and immediate, delete is not (deleteCharacter cascades to the
 * character's map_tokens/character_resources/character_pawns/
 * action_overrides — a real, irreversible loss). RLS (0008's "owner or
 * campaign DM can update/delete a character") is the actual authorization
 * either way; this page only ever lists the CALLER's own characters
 * (listCharactersForUser), so every row here is already something they own.
 */
export function CharacterLibraryRow({ character }: { character: OwnedCharacter }) {
  const [renameState, renameAction, renamePending] = useActionState(
    renameCharacterAction.bind(null, character.id),
    initialState
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteCharacterAction.bind(null, character.id),
    initialState
  );
  const [confirming, setConfirming] = useState(false);

  return (
    <li className={styles.manageRow}>
      <div className={styles.manageHeader}>
        {character.campaign ? (
          <Link
            href={`/campaigns/${character.campaign.id}/characters/${character.id}`}
            className={styles.characterLink}
          >
            {character.name}
          </Link>
        ) : (
          <span>{character.name}</span>
        )}
        <span className={styles.characterMeta}>
          <Badge tone="teal">
            {character.class} {character.level}
          </Badge>
          <Badge tone="purple">{character.campaign?.name ?? "No campaign"}</Badge>
        </span>
      </div>

      <form action={renameAction} className={styles.renameForm}>
        <TextInput
          label="Character name"
          name="name"
          required
          defaultValue={character.name}
          error={renameState.error}
          disabled={renamePending}
          className={styles.renameField}
        />
        <Button type="submit" variant="teal" size="sm" disabled={renamePending}>
          {renamePending ? "Renaming…" : "Rename"}
        </Button>
      </form>

      {confirming ? (
        <form action={deleteAction} className={styles.actionRow}>
          <span className={styles.confirmHint}>
            Delete “{character.name}”? This can&apos;t be undone.
          </span>
          <Button type="submit" variant="danger" size="sm" disabled={deletePending}>
            {deletePending ? "Deleting…" : "Confirm delete"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(false)}
            disabled={deletePending}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div className={styles.actionRow}>
          <Button type="button" variant="danger" size="sm" onClick={() => setConfirming(true)}>
            Delete character
          </Button>
        </div>
      )}
      {deleteState.error ? (
        <p role="alert" className={styles.errorText}>
          {deleteState.error}
        </p>
      ) : null}
    </li>
  );
}
