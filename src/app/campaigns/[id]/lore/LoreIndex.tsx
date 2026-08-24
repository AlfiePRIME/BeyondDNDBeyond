"use client";

import Link from "next/link";
import type { LorePage, LorePageLink } from "@/data-access";
import styles from "./lore.module.css";

/**
 * The campaign's full lore index: every page, each showing which other pages
 * it's linked to (either direction — same undirected-wiki reading as
 * listLorePageLinks). Pure browsing; all editing lives on the detail route.
 */
export function LoreIndex({
  campaignId,
  pages,
  links,
  canManage,
}: {
  campaignId: string;
  pages: LorePage[];
  links: LorePageLink[];
  canManage: boolean;
}) {
  const titlesById = new Map(pages.map((page) => [page.id, page.title]));

  function linkedPages(pageId: string): { id: string; title: string }[] {
    return links
      .filter((link) => link.from_page_id === pageId || link.to_page_id === pageId)
      .map((link) => (link.from_page_id === pageId ? link.to_page_id : link.from_page_id))
      .map((id) => ({ id, title: titlesById.get(id) ?? "Unknown page" }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  if (pages.length === 0) {
    return (
      <p className={styles.emptyHint} data-testid="lore-index-empty">
        {canManage
          ? "No pages yet — write the first entry in your world's lore."
          : "No pages yet — the DM hasn't written any lore."}
      </p>
    );
  }

  return (
    <div className={styles.index}>
      {pages.map((page) => {
        const linked = linkedPages(page.id);
        return (
          <article key={page.id} className={styles.card} data-testid={`lore-page-card-${page.id}`}>
            <Link
              href={`/campaigns/${campaignId}/lore/${page.id}`}
              className={styles.cardTitle}
              data-testid={`lore-page-title-link-${page.id}`}
            >
              {page.title}
            </Link>
            {page.body ? <p className={styles.cardExcerpt}>{page.body}</p> : null}
            {linked.length > 0 ? (
              <span className={styles.cardLinksRow} data-testid={`lore-page-links-${page.id}`}>
                <span className={styles.cardLinksLabel}>Linked to</span>
                {linked.map((other) => (
                  <Link
                    key={other.id}
                    href={`/campaigns/${campaignId}/lore/${other.id}`}
                    className={styles.cardLinkChip}
                  >
                    {other.title}
                  </Link>
                ))}
              </span>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
