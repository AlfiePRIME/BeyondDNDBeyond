"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Panel, Select, TextInput } from "@/ui-components";
import {
  updateLorePage,
  deleteLorePage,
  linkLorePages,
  unlinkLorePages,
  type LorePage,
  type LorePageLink,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import styles from "../lore.module.css";

/**
 * One lore page: title and body for every member, plus the DM-only editing
 * surface. Editing is a full inline form (not a modal) — a page body is
 * long-form prose, and swapping the reading view for the editing view keeps
 * the whole text visible while writing.
 */
export function LorePageView({
  campaignId,
  initialPage,
  initialLinks,
  allPages,
  canManage,
}: {
  campaignId: string;
  initialPage: LorePage;
  initialLinks: LorePageLink[];
  allPages: LorePage[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [page, setPage] = useState(initialPage);
  const [links, setLinks] = useState(initialLinks);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");
  const [linkTarget, setLinkTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const titlesById = new Map(allPages.map((p) => [p.id, p.title]));
  const linkedIds = new Set(
    links.map((link) => (link.from_page_id === page.id ? link.to_page_id : link.from_page_id))
  );
  const linked = [...linkedIds]
    .map((id) => ({ id, title: titlesById.get(id) ?? "Unknown page" }))
    .sort((a, b) => a.title.localeCompare(b.title));
  const linkablePages = allPages.filter((p) => p.id !== page.id && !linkedIds.has(p.id));

  function startEditing() {
    setTitleDraft(page.title);
    setBodyDraft(page.body ?? "");
    setPageError(null);
    setEditing(true);
  }

  async function handleSave() {
    if (!titleDraft.trim()) return;
    setPageError(null);
    setBusy(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const updated = await updateLorePage(supabase, page.id, {
        title: titleDraft.trim(),
        body: bodyDraft.trim() || null,
      });
      setPage(updated);
      setEditing(false);
    } catch {
      setPageError("Couldn't save this page — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setPageError(null);
    setBusy(true);
    try {
      const supabase = createBrowserSupabaseClient();
      await deleteLorePage(supabase, page.id);
      router.push(`/campaigns/${campaignId}/lore`);
    } catch {
      setPageError("Couldn't delete this page — try again.");
      setBusy(false);
    }
  }

  async function handleAddLink() {
    if (!linkTarget) return;
    setLinkError(null);
    setBusy(true);
    try {
      const supabase = createBrowserSupabaseClient();
      await linkLorePages(supabase, page.id, linkTarget);
      setLinks((current) => [...current, { from_page_id: page.id, to_page_id: linkTarget }]);
      setLinkTarget("");
    } catch {
      setLinkError("Couldn't link these pages — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveLink(otherId: string) {
    const link = links.find(
      (l) =>
        (l.from_page_id === page.id && l.to_page_id === otherId) ||
        (l.to_page_id === page.id && l.from_page_id === otherId)
    );
    if (!link) return;
    setLinkError(null);
    setBusy(true);
    try {
      const supabase = createBrowserSupabaseClient();
      await unlinkLorePages(supabase, link.from_page_id, link.to_page_id);
      setLinks((current) => current.filter((l) => l !== link));
    } catch {
      setLinkError("Couldn't remove this link — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.detail}>
      <Panel
        title={editing ? "Editing page" : page.title}
        tone="purple"
        glow
        data-testid="lore-page-panel"
        headerActions={
          canManage && !editing ? (
            <span className={styles.detailToolbar}>
              <Button size="sm" variant="ghost" onClick={startEditing} data-testid="edit-lore-page-button">
                Edit
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={handleDelete}
                data-testid="delete-lore-page-button"
              >
                Delete
              </Button>
            </span>
          ) : null
        }
      >
        {editing ? (
          <div className={styles.form}>
            <TextInput
              label="Title"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              disabled={busy}
              data-testid="lore-page-title-input"
            />
            <label className={styles.textareaField}>
              <span className={styles.textareaLabel}>Content</span>
              <textarea
                className={styles.textarea}
                value={bodyDraft}
                onChange={(event) => setBodyDraft(event.target.value)}
                placeholder="The history, the rumors, the truth…"
                disabled={busy}
                data-testid="lore-page-body-input"
              />
            </label>
            <div className={styles.formActions}>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                variant="accent"
                disabled={busy || !titleDraft.trim()}
                onClick={handleSave}
                data-testid="save-lore-page-button"
              >
                {busy ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        ) : page.body ? (
          <p className={styles.body} data-testid="lore-page-body">
            {page.body}
          </p>
        ) : (
          <p className={styles.emptyHint} data-testid="lore-page-body">
            This page has no content yet.
          </p>
        )}
        {pageError ? (
          <p role="alert" className={styles.errorText} data-testid="lore-page-error">
            {pageError}
          </p>
        ) : null}
      </Panel>

      <Panel title="Links" tone="teal">
        {linked.length === 0 ? (
          <p className={styles.emptyHint} data-testid="lore-page-links-empty">
            This page isn&apos;t linked to any other page yet.
          </p>
        ) : (
          <ul className={styles.linkList}>
            {linked.map((other) => (
              <li key={other.id} className={styles.linkRow}>
                <Link
                  href={`/campaigns/${campaignId}/lore/${other.id}`}
                  className={styles.pageLink}
                  data-testid={`lore-page-link-${other.id}`}
                >
                  {other.title}
                </Link>
                {canManage ? (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() => handleRemoveLink(other.id)}
                    data-testid={`remove-lore-link-${other.id}`}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canManage && linkablePages.length > 0 ? (
          <div className={styles.addLinkRow}>
            <Select
              label="Link to another page"
              className={styles.addLinkSelect}
              value={linkTarget}
              disabled={busy}
              onChange={(event) => setLinkTarget(event.target.value)}
              data-testid="add-lore-link-select"
            >
              <option value="">Choose a page…</option>
              {linkablePages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </Select>
            <Button
              variant="teal"
              disabled={busy || !linkTarget}
              onClick={handleAddLink}
              data-testid="add-lore-link-button"
            >
              Add link
            </Button>
          </div>
        ) : null}
        {linkError ? (
          <p role="alert" className={styles.errorText} data-testid="lore-link-error">
            {linkError}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
