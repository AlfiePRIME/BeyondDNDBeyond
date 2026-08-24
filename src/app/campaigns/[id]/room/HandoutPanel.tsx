"use client";

import { useRef, useState } from "react";
import { Badge, Button, TextInput } from "@/ui-components";
import { isImageHandout, type RoomHandout } from "./handout-url";
import styles from "./room.module.css";

const HANDOUT_ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";

/** A handout's actual content — inline for images, an open link for
 * documents. Shared between the panel list and the live-reveal modal. */
export function HandoutContent({ handout }: { handout: RoomHandout }) {
  if (!handout.url) return null;
  if (isImageHandout(handout)) {
    return (
      // Signed Storage URLs are transient and can't be allowlisted for
      // next/image's optimizer — same call as MapPanel's revealed images.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={handout.url}
        alt={handout.title}
        className={styles.revealedImage}
        data-testid={`handout-image-${handout.id}`}
      />
    );
  }
  return (
    <a
      href={handout.url}
      target="_blank"
      rel="noreferrer"
      className={styles.handoutLink}
      data-testid={`handout-link-${handout.id}`}
    >
      Open handout ↗
    </a>
  );
}

/**
 * The Game Room's handout side panel: every campaign handout for the DM
 * (with reveal/hide/delete and an upload form), only already-revealed ones
 * for players — that filtering is the handouts SELECT RLS (0020), not
 * client-side logic. Mirrors MapPanel's DM-vs-player gating pattern.
 */
export function HandoutPanel({
  isDM,
  handouts,
  busy,
  error,
  onCreate,
  onToggleReveal,
  onDelete,
}: {
  isDM: boolean;
  handouts: RoomHandout[];
  busy: boolean;
  error: string | null;
  onCreate: (title: string, file: File) => void;
  onToggleReveal: (handout: RoomHandout) => void;
  onDelete: (handout: RoomHandout) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleSubmit() {
    if (!title.trim() || !file) return;
    onCreate(title.trim(), file);
    setCreating(false);
    setTitle("");
    setFile(null);
  }

  return (
    <aside className={styles.handoutPanel} data-testid="handout-panel">
      <span className={styles.panelLabel}>Handouts</span>

      {isDM ? (
        creating ? (
          <div className={styles.handoutForm} data-testid="handout-form">
            <TextInput
              label="Title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="e.g. The Baron's letter"
              disabled={busy}
              data-testid="handout-title-input"
            />
            <div className={styles.objectHeader}>
              <Button
                size="sm"
                variant="teal"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {file ? "Change file" : "Choose file"}
              </Button>
              {file ? <span className={styles.handoutFileName}>{file.name}</span> : null}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={HANDOUT_ACCEPT}
              aria-label="Upload a handout image or PDF"
              className={styles.hiddenFileInput}
              disabled={busy}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              data-testid="handout-file-input"
            />
            <p className={styles.hint}>PNG, JPEG, WebP, or PDF, max 10MB. Uploads start hidden.</p>
            <div className={styles.objectHeader}>
              <Button
                size="sm"
                variant="accent"
                disabled={busy || !title.trim() || !file}
                onClick={handleSubmit}
                data-testid="save-handout-button"
              >
                {busy ? "Uploading…" : "Add handout"}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.objectHeader}>
            <Button
              size="sm"
              variant="accent"
              disabled={busy}
              onClick={() => setCreating(true)}
              data-testid="create-handout-button"
            >
              + New handout
            </Button>
          </div>
        )
      ) : null}

      {handouts.length === 0 ? (
        <p className={styles.hint} data-testid="handout-list-empty">
          {isDM ? "No handouts yet — upload one to reveal later." : "Nothing revealed yet."}
        </p>
      ) : (
        handouts.map((handout) => (
          <div key={handout.id} className={styles.objectRow} data-testid={`handout-${handout.id}`}>
            <div className={styles.objectHeader}>
              <span className={styles.objectName}>{handout.title}</span>
              {isDM ? (
                <Badge
                  tone={handout.revealed ? "teal" : "purple"}
                  data-testid={`handout-state-${handout.id}`}
                >
                  {handout.revealed ? "Revealed" : "Hidden"}
                </Badge>
              ) : null}
            </div>
            {isDM ? (
              <div className={styles.objectHeader}>
                <Button
                  size="sm"
                  variant="teal"
                  disabled={busy}
                  onClick={() => onToggleReveal(handout)}
                  data-testid={`reveal-handout-${handout.id}`}
                >
                  {handout.revealed ? "Hide" : "Reveal"}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => onDelete(handout)}
                  data-testid={`delete-handout-${handout.id}`}
                >
                  Delete
                </Button>
              </div>
            ) : null}
            <HandoutContent handout={handout} />
          </div>
        ))
      )}

      {error ? (
        <p role="alert" className={styles.errorText} data-testid="handout-error">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
