"use client";

import { useState } from "react";
import { Button, TextInput } from "@/ui-components";
import {
  createSessionLogEntry,
  updateSessionLogEntry,
  deleteSessionLogEntry,
  type SessionLogEntry,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import styles from "./session-log.module.css";

function entryDate(entry: SessionLogEntry): string {
  return new Date(entry.created_at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The campaign's session log as a chronological (oldest-first, matching
 * listSessionLogEntries' created_at ordering) list of recap entries, plus
 * the DM-only write flow: one form serves both "add a recap" and
 * edit-in-place, same single-form pattern as NpcRoster's modal.
 */
export function SessionLog({
  campaignId,
  initialEntries,
  canManage,
}: {
  campaignId: string;
  initialEntries: SessionLogEntry[];
  canManage: boolean;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [editing, setEditing] = useState<SessionLogEntry | "new" | null>(null);
  const [label, setLabel] = useState("");
  const [recap, setRecap] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  function openCreate() {
    setEditing("new");
    setLabel("");
    setRecap("");
    setFormError(null);
  }

  function openEdit(entry: SessionLogEntry) {
    setEditing(entry);
    setLabel(entry.label ?? "");
    setRecap(entry.recap ?? "");
    setFormError(null);
  }

  function closeForm() {
    if (busy) return;
    setEditing(null);
  }

  async function handleSave() {
    if (!editing || !recap.trim()) return;
    setFormError(null);
    setBusy(true);
    try {
      const supabase = createBrowserSupabaseClient();
      if (editing === "new") {
        const entry = await createSessionLogEntry(supabase, {
          campaignId,
          label: label.trim() || undefined,
          recap: recap.trim(),
        });
        setEntries((current) => [...current, entry]);
      } else {
        const updated = await updateSessionLogEntry(supabase, editing.id, {
          label: label.trim() || null,
          recap: recap.trim(),
        });
        setEntries((current) =>
          current.map((entry) => (entry.id === updated.id ? updated : entry))
        );
      }
      setEditing(null);
    } catch {
      setFormError("Couldn't save this recap — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(entry: SessionLogEntry) {
    setListError(null);
    try {
      await deleteSessionLogEntry(createBrowserSupabaseClient(), entry.id);
      setEntries((current) => current.filter((candidate) => candidate.id !== entry.id));
    } catch {
      setListError("Couldn't delete that recap — try again.");
    }
  }

  return (
    <div className={styles.log}>
      {canManage && editing === null ? (
        <div className={styles.toolbar}>
          <Button variant="accent" onClick={openCreate} data-testid="create-session-log-button">
            + New recap
          </Button>
        </div>
      ) : null}

      {canManage && editing !== null ? (
        <div className={styles.form} data-testid="session-log-form">
          <TextInput
            label="Label (optional)"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. Session 12"
            disabled={busy}
            data-testid="session-log-label-input"
          />
          <label className={styles.textareaField}>
            <span className={styles.textareaLabel}>Recap</span>
            <textarea
              className={styles.textarea}
              value={recap}
              onChange={(event) => setRecap(event.target.value)}
              placeholder="What happened this session…"
              disabled={busy}
              data-testid="session-log-recap-input"
            />
          </label>
          <div className={styles.formActions}>
            <Button
              variant="accent"
              disabled={busy || !recap.trim()}
              onClick={handleSave}
              data-testid="save-session-log-button"
            >
              {busy ? "Saving…" : editing === "new" ? "Publish recap" : "Save changes"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={closeForm}>
              Cancel
            </Button>
          </div>
          {formError ? (
            <p role="alert" className={styles.errorText} data-testid="session-log-form-error">
              {formError}
            </p>
          ) : null}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className={styles.emptyHint} data-testid="session-log-empty">
          {canManage
            ? "No recaps yet — write the first entry after your next session."
            : "No recaps yet — the DM hasn't written any."}
        </p>
      ) : (
        <ol className={styles.entryList}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.entry} data-testid={`session-log-entry-${entry.id}`}>
              <div className={styles.entryHeader}>
                <span className={styles.entryLabel}>{entry.label ?? "Untitled session"}</span>
                <span className={styles.entryDate}>{entryDate(entry)}</span>
                {canManage ? (
                  <span className={styles.entryActions}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEdit(entry)}
                      data-testid={`edit-session-log-${entry.id}`}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleDelete(entry)}
                      data-testid={`delete-session-log-${entry.id}`}
                    >
                      Delete
                    </Button>
                  </span>
                ) : null}
              </div>
              {entry.recap ? <p className={styles.entryRecap}>{entry.recap}</p> : null}
            </li>
          ))}
        </ol>
      )}

      {listError ? (
        <p role="alert" className={styles.errorText} data-testid="session-log-error">
          {listError}
        </p>
      ) : null}
    </div>
  );
}
