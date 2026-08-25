"use client";

import { useState } from "react";
import styles from "./campaign.module.css";

export interface InviteCodeBadgeProps {
  inviteCode: string;
}

/**
 * DM-only invite code affordance for the campaign detail page's header —
 * the invite code was previously visible in exactly one place (the DM's own
 * row in /campaigns' "Your campaigns" list), leaving no way to find it once
 * already inside a campaign. Copy is a nice-to-have on top of the plainly
 * displayed, easily-selectable code text, which is the functional minimum.
 */
export function InviteCodeBadge({ inviteCode }: InviteCodeBadgeProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied/unavailable — the code is still
      // plainly visible and selectable, so this is a silent no-op.
    }
  }

  return (
    <span className={styles.inviteCode} data-testid="invite-code">
      Invite code: <code>{inviteCode}</code>
      <button type="button" className={styles.copyButton} onClick={handleCopy} data-testid="invite-code-copy">
        {copied ? "Copied!" : "Copy"}
      </button>
    </span>
  );
}
