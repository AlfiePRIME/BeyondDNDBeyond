"use client";

import { useRef, useState, type ReactNode } from "react";
import { Button, Modal, TextInput } from "@/ui-components";
import {
  createNpc,
  updateNpc,
  deleteNpc,
  uploadNpcPortraitFile,
  getNpcPortraitSignedUrl,
  type Npc,
  type UpdateNpcPatch,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { GenerateDraftControl } from "../GenerateDraftControl";
import styles from "./npcs.module.css";

export interface RosterNpc extends Npc {
  /** Signed URL resolved server-side on load, client-side after an upload. */
  portraitUrl: string | null;
}

const SIGNED_URL_TTL_SECONDS = 6 * 60 * 60;

const PORTRAIT_ACCEPT = "image/png,image/jpeg,image/webp";

function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  testId,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <label className={styles.textareaField}>
      <span className={styles.textareaLabel}>{label}</span>
      <textarea
        className={styles.textarea}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        data-testid={testId}
      />
    </label>
  );
}

function byName(a: RosterNpc, b: RosterNpc): number {
  return a.name.localeCompare(b.name);
}

/**
 * The campaign's full NPC roster as a browsable card grid, plus the DM-only
 * management flow: one modal form serves both create and edit-in-place,
 * uploading the portrait to the npc-portraits bucket before writing the
 * npcs row so a row never points at a not-yet-existing object.
 */
export function NpcRoster({
  campaignId,
  initialNpcs,
  canManage,
  aiEnabled,
}: {
  campaignId: string;
  initialNpcs: RosterNpc[];
  canManage: boolean;
  /** Resolved server-side via isAiConfigured() — gates the generate action. */
  aiEnabled: boolean;
}) {
  const [npcs, setNpcs] = useState(initialNpcs);
  const [editing, setEditing] = useState<RosterNpc | "new" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [relationshipNotes, setRelationshipNotes] = useState("");
  const [portraitFile, setPortraitFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function openCreate() {
    setEditing("new");
    setName("");
    setDescription("");
    setRelationshipNotes("");
    setPortraitFile(null);
    setFormError(null);
  }

  function openEdit(npc: RosterNpc) {
    setEditing(npc);
    setName(npc.name);
    setDescription(npc.description ?? "");
    setRelationshipNotes(npc.relationship_notes ?? "");
    setPortraitFile(null);
    setFormError(null);
  }

  function closeForm() {
    if (busy) return;
    setEditing(null);
  }

  async function handleSave() {
    if (!editing || !name.trim()) return;
    setFormError(null);
    setBusy(true);
    try {
      const supabase = createBrowserSupabaseClient();

      let portraitRef: string | null = null;
      let portraitUrl: string | null = null;
      if (portraitFile) {
        portraitRef = await uploadNpcPortraitFile(supabase, campaignId, portraitFile);
        portraitUrl = await getNpcPortraitSignedUrl(supabase, portraitRef, SIGNED_URL_TTL_SECONDS);
      }

      if (editing === "new") {
        const npc = await createNpc(supabase, {
          campaignId,
          name,
          description: description.trim() || undefined,
          portraitRef: portraitRef ?? undefined,
          relationshipNotes: relationshipNotes.trim() || undefined,
        });
        setNpcs((current) => [...current, { ...npc, portraitUrl }].sort(byName));
      } else {
        const patch: UpdateNpcPatch = {
          name: name.trim(),
          description: description.trim() || null,
          relationship_notes: relationshipNotes.trim() || null,
        };
        if (portraitRef) patch.portrait_ref = portraitRef;
        const updated = await updateNpc(supabase, editing.id, patch);
        setNpcs((current) =>
          current
            .map((npc) =>
              npc.id === updated.id
                ? { ...updated, portraitUrl: portraitUrl ?? npc.portraitUrl }
                : npc
            )
            .sort(byName)
        );
      }
      setEditing(null);
    } catch {
      setFormError("Couldn't save this NPC — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(npc: RosterNpc) {
    setRosterError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      await deleteNpc(supabase, npc.id);
      setNpcs((current) => current.filter((n) => n.id !== npc.id));
    } catch {
      setRosterError(`Couldn't delete ${npc.name} — try again.`);
    }
  }

  return (
    <div className={styles.roster}>
      {canManage ? (
        <div className={styles.rosterToolbar}>
          <Button variant="accent" onClick={openCreate} data-testid="create-npc-button">
            + New NPC
          </Button>
        </div>
      ) : null}

      {npcs.length === 0 ? (
        <p className={styles.emptyHint} data-testid="npc-roster-empty">
          {canManage
            ? "No NPCs yet — create the first face of your world."
            : "No NPCs yet — the DM hasn't introduced anyone."}
        </p>
      ) : (
        <div className={styles.grid}>
          {npcs.map((npc) => (
            <article key={npc.id} className={styles.card} data-testid={`npc-card-${npc.id}`}>
              <div className={styles.portraitFrame}>
                {npc.portraitUrl ? (
                  // Signed Storage URLs are transient and can't be allowlisted
                  // for next/image's optimizer — same call as MapPanel's
                  // revealed images.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={npc.portraitUrl}
                    alt={`Portrait of ${npc.name}`}
                    className={styles.portrait}
                    data-testid={`npc-portrait-${npc.id}`}
                  />
                ) : (
                  <span className={styles.portraitPlaceholder} aria-hidden="true">
                    ?
                  </span>
                )}
              </div>
              <span className={styles.cardName}>{npc.name}</span>
              {npc.description ? <p className={styles.cardText}>{npc.description}</p> : null}
              {npc.relationship_notes ? (
                <>
                  <span className={styles.cardSectionLabel}>Relationships</span>
                  <p className={styles.cardText}>{npc.relationship_notes}</p>
                </>
              ) : null}
              {canManage ? (
                <div className={styles.cardActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openEdit(npc)}
                    data-testid={`edit-npc-${npc.id}`}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => handleDelete(npc)}
                    data-testid={`delete-npc-${npc.id}`}
                  >
                    Delete
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}

      {rosterError ? (
        <p role="alert" className={styles.errorText} data-testid="npc-roster-error">
          {rosterError}
        </p>
      ) : null}

      <Modal
        open={editing !== null}
        onClose={closeForm}
        title={editing === "new" ? "New NPC" : "Edit NPC"}
        footer={
          <Button
            variant="accent"
            disabled={busy || !name.trim()}
            onClick={handleSave}
            data-testid="save-npc-button"
          >
            {busy ? "Saving…" : editing === "new" ? "Add to roster" : "Save changes"}
          </Button>
        }
      >
        <div className={styles.form}>
          <TextInput
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Baron Aldric Vane"
            disabled={busy}
            data-testid="npc-name-input"
          />
          <GenerateDraftControl
            campaignId={campaignId}
            kind="npc"
            aiEnabled={aiEnabled}
            disabled={busy}
            onDraft={setDescription}
          />
          <TextareaField
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="Who they are, how they carry themselves…"
            disabled={busy}
            testId="npc-description-input"
          />
          <TextareaField
            label="Relationship notes"
            value={relationshipNotes}
            onChange={setRelationshipNotes}
            placeholder="e.g. Owes a debt to the Baron; secretly Vex's estranged father"
            disabled={busy}
            testId="npc-relationship-input"
          />
          <div className={styles.portraitRow}>
            <Button
              size="sm"
              variant="teal"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              {portraitFile ? "Change portrait" : "Choose portrait"}
            </Button>
            {portraitFile ? (
              <span className={styles.portraitFileName}>{portraitFile.name}</span>
            ) : editing !== "new" && editing?.portrait_ref ? (
              <span className={styles.portraitFileName}>Keeping the current portrait</span>
            ) : null}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept={PORTRAIT_ACCEPT}
            aria-label="Upload an NPC portrait image"
            className={styles.hiddenFileInput}
            disabled={busy}
            onChange={(event) => setPortraitFile(event.target.files?.[0] ?? null)}
            data-testid="npc-portrait-input"
          />
          <p className={styles.uploadHint}>Portraits: PNG, JPEG, or WebP, max 5MB.</p>
          {formError ? (
            <p role="alert" className={styles.errorText} data-testid="npc-form-error">
              {formError}
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
