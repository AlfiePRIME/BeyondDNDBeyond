"use client";

import { useEffect, useState } from "react";
import { Button, TextInput } from "@/ui-components";
import {
  addContainerItem,
  listContainerItems,
  removeContainerItem,
  updateContainerItem,
  type ContainerRef,
  type MapObjectItem,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import styles from "./editor.module.css";

// Structural message read, not instanceof — see GameRoom's own note on the
// browser-bundled PostgrestError.
function errorMessage(err: unknown): string | null {
  return err && typeof err === "object" && "message" in err && typeof err.message === "string"
    ? err.message
    : null;
}

// Map Editor Batch A5: an empty field means "not hidden" (null) — anything
// else must be a positive integer DC, the MonsterPanel's own positiveInt
// convention (blank is legal here, unlike there, since "not hidden" is
// this field's own default state, not an error).
function parseHiddenDc(raw: string): { value: number | null; valid: boolean } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, valid: true };
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? { value: parsed, valid: true } : { value: null, valid: false };
}

/**
 * Map Editor Batch A4: a chest or (still-concealed) pit's item contents —
 * flavor loot (name/description/optional icon/optional tag), NOT a full
 * weapon/armor stat block. DM-only authoring, enforced server-side by
 * map_object_items' own INSERT/UPDATE/DELETE RLS (0060) — this component
 * has no permission logic of its own; a non-DM caller's writes would
 * simply be rejected by the database.
 *
 * Mount keyed by the container's own id (BehaviorEditor/ObjectTagEditor's
 * own pattern) so switching selection re-fetches THIS container's items
 * rather than showing whatever the previous selection had loaded.
 */
export function ContainerItemsEditor({
  campaignId,
  container,
}: {
  campaignId: string;
  container: ContainerRef;
}) {
  const [items, setItems] = useState<MapObjectItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tag, setTag] = useState("");
  // Map Editor Batch A5: blank means "not hidden" — see parseHiddenDc.
  const [hiddenDc, setHiddenDc] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTag, setEditTag] = useState("");
  const [editHiddenDc, setEditHiddenDc] = useState("");

  useEffect(() => {
    // No setLoading(true) here: this component is mounted keyed by the
    // container's own id (see this component's own doc comment), so a
    // container switch is a fresh mount that already starts at loading's
    // useState(true) default — nothing to reset.
    let cancelled = false;
    listContainerItems(createBrowserSupabaseClient(), container)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err) ?? "Could not load items.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Only the container identity should re-trigger the fetch — campaignId
    // never changes for a mounted editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container.mapObjectId, container.concealedPitId]);

  async function handleAdd() {
    const trimmed = name.trim();
    const parsedHiddenDc = parseHiddenDc(hiddenDc);
    if (!trimmed || !parsedHiddenDc.valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await addContainerItem(createBrowserSupabaseClient(), {
        ...container,
        campaignId,
        name: trimmed,
        description: description.trim() === "" ? null : description.trim(),
        tag: tag.trim() === "" ? null : tag.trim(),
        hiddenDc: parsedHiddenDc.value,
      });
      setItems((current) => [...current, created]);
      setName("");
      setDescription("");
      setTag("");
      setHiddenDc("");
    } catch (err) {
      setError(errorMessage(err) ?? "Could not add that item.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(item: MapObjectItem) {
    setEditingId(item.id);
    setEditName(item.name);
    setEditDescription(item.description ?? "");
    setEditTag(item.tag ?? "");
    setEditHiddenDc(item.hidden_dc !== null ? String(item.hidden_dc) : "");
  }

  async function handleSaveEdit(itemId: string) {
    const trimmed = editName.trim();
    const parsedHiddenDc = parseHiddenDc(editHiddenDc);
    if (!trimmed || !parsedHiddenDc.valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateContainerItem(createBrowserSupabaseClient(), itemId, {
        name: trimmed,
        description: editDescription.trim() === "" ? null : editDescription.trim(),
        tag: editTag.trim() === "" ? null : editTag.trim(),
        hidden_dc: parsedHiddenDc.value,
      });
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setEditingId(null);
    } catch (err) {
      setError(errorMessage(err) ?? "Could not save that item.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(itemId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeContainerItem(createBrowserSupabaseClient(), itemId);
      setItems((current) => current.filter((item) => item.id !== itemId));
      if (editingId === itemId) setEditingId(null);
    } catch (err) {
      setError(errorMessage(err) ?? "Could not remove that item.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="container-items-editor">
      <span className={styles.toolbarLabel}>Contents</span>
      {loading ? (
        <p className={styles.hint}>Loading items…</p>
      ) : items.length === 0 ? (
        <p className={styles.hint} data-testid="container-items-empty">
          No items yet.
        </p>
      ) : (
        <div data-testid="container-items-list">
          {items.map((item) =>
            editingId === item.id ? (
              <div key={item.id} className={styles.toolRow} data-testid={`container-item-editing-${item.id}`}>
                <TextInput
                  label="Name"
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  disabled={busy}
                  data-testid="container-item-edit-name-input"
                />
                <TextInput
                  label="Description"
                  value={editDescription}
                  onChange={(event) => setEditDescription(event.target.value)}
                  disabled={busy}
                  data-testid="container-item-edit-description-input"
                />
                <TextInput
                  label="Tag (for the activity feed)"
                  value={editTag}
                  onChange={(event) => setEditTag(event.target.value)}
                  disabled={busy}
                  data-testid="container-item-edit-tag-input"
                />
                <TextInput
                  label="Hidden DC (blank = not hidden)"
                  type="number"
                  min={1}
                  value={editHiddenDc}
                  onChange={(event) => setEditHiddenDc(event.target.value)}
                  placeholder="e.g. 15"
                  hint="A viewing character's passive Perception must meet or beat this to see the item."
                  error={parseHiddenDc(editHiddenDc).valid ? undefined : "Enter a positive whole number, or leave blank."}
                  disabled={busy}
                  data-testid="container-item-edit-hidden-dc-input"
                />
                <div className={styles.toolRow}>
                  <Button
                    size="sm"
                    variant="teal"
                    disabled={busy || editName.trim() === "" || !parseHiddenDc(editHiddenDc).valid}
                    onClick={() => void handleSaveEdit(item.id)}
                    data-testid={`save-container-item-${item.id}`}
                  >
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div key={item.id} className={styles.toolRow} data-testid={`container-item-${item.id}`}>
                <span className={styles.selectedMeta}>
                  {item.name}
                  {item.description ? ` — ${item.description}` : ""}
                  {item.tag ? ` (${item.tag})` : ""}
                  {item.hidden_dc !== null ? ` [hidden, DC ${item.hidden_dc}]` : ""}
                </span>
                <Button
                  size="sm"
                  variant="teal"
                  disabled={busy}
                  onClick={() => startEdit(item)}
                  data-testid={`edit-container-item-${item.id}`}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => void handleRemove(item.id)}
                  data-testid={`remove-container-item-${item.id}`}
                >
                  Remove
                </Button>
              </div>
            )
          )}
        </div>
      )}
      <TextInput
        label="New item name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="e.g. Ring of Protection"
        disabled={busy}
        data-testid="container-item-name-input"
      />
      <TextInput
        label="Description (optional)"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="A tarnished silver band…"
        disabled={busy}
        data-testid="container-item-description-input"
      />
      <TextInput
        label="Tag (optional, for the activity feed)"
        value={tag}
        onChange={(event) => setTag(event.target.value)}
        placeholder="e.g. Quest item"
        disabled={busy}
        data-testid="container-item-tag-input"
      />
      <TextInput
        label="Hidden DC (blank = not hidden)"
        type="number"
        min={1}
        value={hiddenDc}
        onChange={(event) => setHiddenDc(event.target.value)}
        placeholder="e.g. 15"
        hint="A viewing character's passive Perception must meet or beat this to see the item — ambient, no roll."
        error={parseHiddenDc(hiddenDc).valid ? undefined : "Enter a positive whole number, or leave blank."}
        disabled={busy}
        data-testid="container-item-hidden-dc-input"
      />
      <div className={styles.toolRow}>
        <Button
          size="sm"
          variant="accent"
          disabled={busy || name.trim() === "" || !parseHiddenDc(hiddenDc).valid}
          onClick={() => void handleAdd()}
          data-testid="add-container-item-button"
        >
          {busy ? "Saving…" : "Add item"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className={styles.errorText} data-testid="container-items-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
