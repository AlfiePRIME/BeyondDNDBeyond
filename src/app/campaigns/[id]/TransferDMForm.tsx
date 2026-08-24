"use client";

import { useActionState } from "react";
import { Button, Select } from "@/ui-components";
import { transferDMAction } from "./actions";
import type { FormActionState } from "../../actions";
import type { CampaignMember } from "@/data-access";

const initialState: FormActionState = {};

export function TransferDMForm({
  campaignId,
  otherMembers,
}: {
  campaignId: string;
  otherMembers: CampaignMember[];
}) {
  const boundAction = transferDMAction.bind(null, campaignId);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  if (otherMembers.length === 0) {
    return null;
  }

  return (
    <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Select label="Hand the DM role to" name="newDmUserId" required error={state.error} disabled={isPending}>
        <option value="">Choose a player…</option>
        {otherMembers.map((member) => (
          <option key={member.user_id} value={member.user_id}>
            {member.display_name ?? "Unnamed player"}
          </option>
        ))}
      </Select>
      <Button type="submit" variant="danger" disabled={isPending}>
        {isPending ? "Transferring…" : "Transfer DM role"}
      </Button>
    </form>
  );
}
