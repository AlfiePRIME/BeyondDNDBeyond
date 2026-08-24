"use client";

import { useState } from "react";
import Link from "next/link";
import { Select } from "@/ui-components";
import type { CampaignMembership } from "@/data-access";
import styles from "./account.module.css";

/**
 * Creation and PDF import are campaign-scoped routes, so a user in more
 * than one campaign picks which campaign the new character belongs to
 * before following either link.
 */
export function CharacterCreateLauncher({ memberships }: { memberships: CampaignMembership[] }) {
  const [campaignId, setCampaignId] = useState(memberships[0]?.campaign.id ?? "");

  if (memberships.length === 0) return null;

  return (
    <div className={styles.launcher}>
      {memberships.length > 1 ? (
        <Select
          label="Add a character to"
          value={campaignId}
          onChange={(event) => setCampaignId(event.target.value)}
        >
          {memberships.map(({ campaign }) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>
          ))}
        </Select>
      ) : null}
      <div className={styles.launcherLinks}>
        <Link href={`/campaigns/${campaignId}/characters/new`} className={styles.createLink}>
          + Create a character
        </Link>
        <Link href={`/campaigns/${campaignId}/characters/import`} className={styles.createLink}>
          Import from D&amp;D Beyond PDF
        </Link>
      </div>
    </div>
  );
}
