"use client";

import { useState } from "react";
import { Button } from "@/ui-components";
import { createDmNote, updateDmNote, deleteDmNote, type DmNote } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import styles from "./dm-notes.module.css";

function noteDate(note: DmNote): string {
  return new Date(note.created_at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The DM's private scratchpad: a list of freeform notes, newest first — a
 * running log of secrets and plot threads reads better most-recent-on-top
 * than session log's oldest-first recap history. Every route to this page
 * already redirects a non-DM away, and dm_notes' RLS (0020) has no
 * member-read policy at all, so this component never renders for anyone else.
 */
export function DmNotes({ campaignId, initialNotes }: { campaignId: string; initialNotes: DmNote[] }) {
  const [notes, setNotes] = useState(initialNotes);
  const [editing, setEditing] = useState<DmNote | "new" | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  function openCreate() {
    setEditing("new");
    setBody("");
    setFormError(null);
  }

  function openEdit(note: DmNote) {
    setEditing(note);
    setBody(note.body ?? "");
    setFormError(null);
  }

  function closeForm() {
    if (busy) return;
    setEditing(null);
  }

  async function handleSave() {
    if (!editing || !body.trim()) return;
    setFormError(null);
    setBusy(true);
    try {
      const supabase = createBrowserSupabaseClient();
      if (editing === "new") {
        const note = await createDmNote(supabase, { campaignId, body: body.trim() });
        setNotes((current) => [note, ...current]);
      } else {
        const updated = await updateDmNote(supabase, editing.id, body.trim());
        setNotes((current) => current.map((note) => (note.id === updated.id ? updated : note)));
      }
      setEditing(null);
    } catch {
      setFormError("Couldn't save this note — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(note: DmNote) {
    setListError(null);
    try {
      await deleteDmNote(createBrowserSupabaseClient(), note.id);
      setNotes((current) => current.filter((candidate) => candidate.id !== note.id));
    } catch {
      setListError("Couldn't delete that note — try again.");
    }
  }

  return (
    <div className={styles.notes}>
      {editing === null ? (
        <div className={styles.toolbar}>
          <Button variant="accent" onClick={openCreate} data-testid="create-dm-note-button">
            + New note
          </Button>
        </div>
      ) : (
        <div className={styles.form} data-testid="dm-note-form">
          <label className={styles.textareaField}>
            <span className={styles.textareaLabel}>Note</span>
            <textarea
              className={styles.textarea}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Secrets, plot threads, reminders for next session…"
              disabled={busy}
              data-testid="dm-note-body-input"
            />
          </label>
          <div className={styles.formActions}>
            <Button
              variant="accent"
              disabled={busy || !body.trim()}
              onClick={handleSave}
              data-testid="save-dm-note-button"
            >
              {busy ? "Saving…" : editing === "new" ? "Add note" : "Save changes"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={closeForm}>
              Cancel
            </Button>
          </div>
          {formError ? (
            <p role="alert" className={styles.errorText} data-testid="dm-note-form-error">
              {formError}
            </p>
          ) : null}
        </div>
      )}

      {notes.length === 0 ? (
        <p className={styles.emptyHint} data-testid="dm-notes-empty">
          No notes yet — jot down anything you don&apos;t want the table to see.
        </p>
      ) : (
        <ul className={styles.noteList}>
          {notes.map((note) => (
            <li key={note.id} className={styles.note} data-testid={`dm-note-${note.id}`}>
              <div className={styles.noteHeader}>
                <span className={styles.noteDate}>{noteDate(note)}</span>
                <span className={styles.noteActions}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => openEdit(note)}
                    data-testid={`edit-dm-note-${note.id}`}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => handleDelete(note)}
                    data-testid={`delete-dm-note-${note.id}`}
                  >
                    Delete
                  </Button>
                </span>
              </div>
              {note.body ? <p className={styles.noteBody}>{note.body}</p> : null}
            </li>
          ))}
        </ul>
      )}

      {listError ? (
        <p role="alert" className={styles.errorText} data-testid="dm-notes-error">
          {listError}
        </p>
      ) : null}
    </div>
  );
}
