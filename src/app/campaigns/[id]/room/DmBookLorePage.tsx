"use client";

import { useState } from "react";
import { Button, TextInput } from "@/ui-components";
import { createLorePage, type LorePage, type LorePageLink } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import styles from "./DmBook.module.css";

type ViewState =
  | { mode: "list" }
  | { mode: "view"; pageId: string }
  | { mode: "edit"; pageId: string | "new" };

/**
 * The DM's book's Lore page (Phase 4): local component state instead of the
 * standalone /campaigns/[id]/lore/* routes' real `<Link>` navigation —
 * routing away mid-session would unmount the whole Game Room (and its
 * <Canvas>), which the book must never do. Calls narrative.ts's
 * createLorePage directly, the same data layer LoreIndex/LorePageView/
 * NewLorePageForm use on the routed pages.
 *
 * Scoped to browse + view + create-new only for this phase, per the plan:
 * cross-link editing/management (LorePageView's link add/remove UI) and
 * full prose re-editing of an EXISTING page stay on the standalone route —
 * that's real, non-trivial UI surface (the wiki graph), and the book's job
 * during a live session is quick reference and jotting down a new page,
 * not building out links between pages. The view page links out to the
 * full editor in a NEW TAB (target="_blank") specifically so a DM who
 * wants deeper editing doesn't lose the live Game Room to do it. `edit`
 * mode is written generically (pageId: string | "new", matching the
 * plan's sketch) but this file's own UI only ever reaches it with "new" —
 * editing an existing page's title/body isn't wired up here on purpose.
 */
export function DmBookLorePage({
  campaignId,
  initialPages,
  initialLinks,
}: {
  campaignId: string;
  initialPages: LorePage[];
  initialLinks: LorePageLink[];
}) {
  const [pages, setPages] = useState<LorePage[]>(initialPages);
  // Links are read-only here (see the doc comment) — no setter needed,
  // just the initial SSR snapshot for the "Linked to" chips.
  const [links] = useState<LorePageLink[]>(initialLinks);
  const [view, setView] = useState<ViewState>({ mode: "list" });
  const [titleDraft, setTitleDraft] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titlesById = new Map(pages.map((page) => [page.id, page.title]));

  function linkedTitles(pageId: string): { id: string; title: string }[] {
    return links
      .filter((link) => link.from_page_id === pageId || link.to_page_id === pageId)
      .map((link) => (link.from_page_id === pageId ? link.to_page_id : link.from_page_id))
      .map((id) => ({ id, title: titlesById.get(id) ?? "Unknown page" }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  function openNew() {
    setTitleDraft("");
    setBodyDraft("");
    setError(null);
    setView({ mode: "edit", pageId: "new" });
  }

  async function handleCreate() {
    if (!titleDraft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const page = await createLorePage(supabase, {
        campaignId,
        title: titleDraft,
        body: bodyDraft.trim() || undefined,
      });
      setPages((current) => [...current, page].sort((a, b) => a.title.localeCompare(b.title)));
      setView({ mode: "view", pageId: page.id });
    } catch {
      setError("Couldn't create this page — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (view.mode === "list") {
    return (
      <div className={styles.lorePage} data-testid="dm-book-lore-list">
        <div className={styles.loreToolbar}>
          <span />
          <Button size="sm" variant="accent" onClick={openNew} data-testid="dm-book-lore-new-button">
            + New page
          </Button>
        </div>
        {pages.length === 0 ? (
          <p className={styles.loreHint} data-testid="dm-book-lore-empty">
            No pages yet — jot down the first entry in your world&apos;s lore.
          </p>
        ) : (
          <div className={styles.loreList}>
            {pages.map((page) => (
              <button
                key={page.id}
                type="button"
                className={styles.loreCard}
                onClick={() => setView({ mode: "view", pageId: page.id })}
                data-testid={`dm-book-lore-open-${page.id}`}
              >
                <span className={styles.loreCardTitle}>{page.title}</span>
                {page.body ? <span className={styles.loreCardExcerpt}>{page.body}</span> : null}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (view.mode === "view") {
    const page = pages.find((candidate) => candidate.id === view.pageId);
    if (!page) {
      return (
        <div className={styles.lorePage} data-testid="dm-book-lore-view">
          <p className={styles.loreHint}>This page no longer exists.</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setView({ mode: "list" })}
            data-testid="dm-book-lore-back"
          >
            ← Back to index
          </Button>
        </div>
      );
    }
    const linked = linkedTitles(page.id);
    return (
      <div className={styles.lorePage} data-testid="dm-book-lore-view">
        <div className={styles.loreToolbar}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setView({ mode: "list" })}
            data-testid="dm-book-lore-back"
          >
            ← Back to index
          </Button>
          <a
            className={styles.loreFullLink}
            href={`/campaigns/${campaignId}/lore/${page.id}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`dm-book-lore-open-full-${page.id}`}
          >
            Full editor &amp; links ↗
          </a>
        </div>
        <h3 className={styles.loreTitle} data-testid="dm-book-lore-view-title">
          {page.title}
        </h3>
        {page.body ? (
          <p className={styles.loreBody} data-testid="dm-book-lore-view-body">
            {page.body}
          </p>
        ) : (
          <p className={styles.loreHint} data-testid="dm-book-lore-view-body">
            This page has no content yet.
          </p>
        )}
        {linked.length > 0 ? (
          <div className={styles.loreLinks} data-testid="dm-book-lore-view-links">
            <span className={styles.loreLinksLabel}>Linked to</span>
            {linked.map((other) => (
              <button
                key={other.id}
                type="button"
                className={styles.loreLinkChip}
                onClick={() => setView({ mode: "view", pageId: other.id })}
              >
                {other.title}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // view.mode === "edit" — only ever reached with pageId "new" from the UI
  // above (see this file's doc comment).
  return (
    <div className={styles.lorePage} data-testid="dm-book-lore-form">
      <TextInput
        label="Title"
        value={titleDraft}
        onChange={(event) => setTitleDraft(event.target.value)}
        placeholder="e.g. The Sunken Keep"
        disabled={busy}
        data-testid="dm-book-lore-title-input"
      />
      <label className={styles.loreTextareaField}>
        <span className={styles.loreTextareaLabel}>Content</span>
        <textarea
          className={styles.loreTextarea}
          value={bodyDraft}
          onChange={(event) => setBodyDraft(event.target.value)}
          placeholder="The history, the rumors, the truth…"
          disabled={busy}
          data-testid="dm-book-lore-body-input"
        />
      </label>
      {error ? (
        <p role="alert" className={styles.loreError} data-testid="dm-book-lore-error">
          {error}
        </p>
      ) : null}
      <div className={styles.loreToolbar}>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setView({ mode: "list" })}
          data-testid="dm-book-lore-cancel"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          variant="accent"
          disabled={busy || !titleDraft.trim()}
          onClick={handleCreate}
          data-testid="dm-book-lore-save"
        >
          {busy ? "Creating…" : "Create page"}
        </Button>
      </div>
    </div>
  );
}
