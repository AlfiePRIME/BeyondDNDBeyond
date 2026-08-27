"use client";

import { useEffect, useState } from "react";
import { Button, Modal } from "@/ui-components";
import {
  createSessionLogEntry,
  createSessionSummaryHighlights,
  endSession,
  type SessionSummaryHighlightCategory,
} from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import styles from "./EndSessionSummaryModal.module.css";

interface DraftHighlight {
  category: SessionSummaryHighlightCategory;
  headline: string;
}

type GeneratePayload = {
  ok?: boolean;
  narrative?: string;
  highlights?: DraftHighlight[];
  aiGenerated?: boolean;
  message?: string;
};

type Stage = "generating" | "ready" | "saving";

const CATEGORY_LABEL: Record<SessionSummaryHighlightCategory, string> = {
  damage: "Damage",
  interaction: "Interaction",
  other: "Other",
};

const FALLBACK_NARRATIVE = "Nothing notable happened this session.";

function defaultLabel(): string {
  return `Session — ${new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })}`;
}

/**
 * Chat & Summary B6: the DM's end-of-session preview/edit screen. GameRoom
 * opens this the moment the DM presses "End session" — it generates a draft
 * via the end-session-summary Route Handler (server-side, so
 * ANTHROPIC_API_KEY never reaches the browser, same as every other
 * AI-assisted surface in this app) and lets the DM edit the narrative freely
 * before anything is saved: nothing reaches players until Confirm.
 *
 * Cancelling does nothing at all — no summary is saved, and the session
 * keeps running exactly as before. That's deliberate: the real endSession
 * RPC call only happens inside handleConfirm below, never before, so a DM
 * who backs out of the preview hasn't ended anything. The Game Room's own
 * best-effort "last one out" cleanup and this modal are the only two
 * callers of endSession in the whole app — this is the only one a summary
 * is ever attached to (see 0069's own end_session doc comment for why the
 * other one deliberately isn't).
 */
export function EndSessionSummaryModal({
  campaignId,
  open,
  onClose,
  onSessionEnded,
}: {
  campaignId: string;
  open: boolean;
  onClose: () => void;
  onSessionEnded: () => void;
}) {
  const [stage, setStage] = useState<Stage>("generating");
  const [narrative, setNarrative] = useState("");
  const [highlights, setHighlights] = useState<DraftHighlight[]>([]);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      // Reset happens here, inside the async request itself, rather than as
      // the effect's own first synchronous statements — every open (fresh
      // or re-opened after a Cancel) always re-fetches, so there's no stale
      // "ready" content briefly visible before this resolves either way.
      setStage("generating");
      setNarrative("");
      setHighlights([]);
      setAiGenerated(false);
      setGenerateError(null);
      setSaveError(null);
      const response = await fetch(`/campaigns/${campaignId}/end-session-summary`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as GeneratePayload | null;
      if (cancelled) return;
      if (!response.ok || !payload?.ok) {
        setGenerateError(
          payload?.message ?? "Couldn't generate a session summary — write one manually below."
        );
        setNarrative(FALLBACK_NARRATIVE);
        setStage("ready");
        return;
      }
      setNarrative(payload.narrative || FALLBACK_NARRATIVE);
      setHighlights(payload.highlights ?? []);
      setAiGenerated(Boolean(payload.aiGenerated));
      setStage("ready");
    })().catch(() => {
      if (cancelled) return;
      setGenerateError("Couldn't generate a session summary — write one manually below.");
      setNarrative(FALLBACK_NARRATIVE);
      setStage("ready");
    });

    return () => {
      cancelled = true;
    };
  }, [open, campaignId]);

  async function handleConfirm() {
    setStage("saving");
    setSaveError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const entry = await createSessionLogEntry(supabase, {
        campaignId,
        label: defaultLabel(),
        recap: narrative.trim() || undefined,
      });
      if (highlights.length > 0) {
        await createSessionSummaryHighlights(supabase, entry.id, highlights);
      }
      await endSession(supabase, campaignId);
      onSessionEnded();
    } catch {
      setSaveError("Couldn't save the session summary — try again.");
      setStage("ready");
    }
  }

  const busy = stage === "generating" || stage === "saving";

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      title="End session — review the recap"
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={onClose}
            data-testid="end-session-summary-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void handleConfirm()}
            data-testid="end-session-summary-confirm"
          >
            {stage === "saving" ? "Ending…" : "Confirm & end session"}
          </Button>
        </>
      }
    >
      <div className={styles.body} data-testid="end-session-summary-modal">
        {stage === "generating" ? (
          <p className={styles.status} data-testid="end-session-summary-generating">
            Generating a summary from this session&apos;s chat and activity…
          </p>
        ) : (
          <>
            {generateError ? (
              <p role="alert" className={styles.error} data-testid="end-session-summary-generate-error">
                {generateError}
              </p>
            ) : !aiGenerated ? (
              <p className={styles.hint} data-testid="end-session-summary-manual-hint">
                AI drafting is unavailable, or this session had no recorded chat or activity — write
                the recap by hand below.
              </p>
            ) : null}
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Narrative recap (editable)</span>
              <textarea
                className={styles.textarea}
                value={narrative}
                onChange={(event) => setNarrative(event.target.value)}
                disabled={stage === "saving"}
                data-testid="end-session-summary-narrative"
              />
            </label>
            <div className={styles.highlightsSection}>
              <span className={styles.fieldLabel}>Mechanical highlights</span>
              {highlights.length === 0 ? (
                <p className={styles.hint} data-testid="end-session-summary-highlights-empty">
                  Nothing structured to report.
                </p>
              ) : (
                <ul className={styles.highlightsList} data-testid="end-session-summary-highlights-list">
                  {highlights.map((highlight, index) => (
                    <li
                      key={index}
                      className={styles.highlightItem}
                      data-testid={`end-session-summary-highlight-${index}`}
                    >
                      <span className={styles.highlightCategory}>{CATEGORY_LABEL[highlight.category]}</span>
                      <span>{highlight.headline}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {saveError ? (
              <p role="alert" className={styles.error} data-testid="end-session-summary-save-error">
                {saveError}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}
