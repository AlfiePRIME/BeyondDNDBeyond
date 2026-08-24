"use client";

import { useActionState } from "react";
import { Button, TextInput } from "@/ui-components";
import { joinCampaignAction, type FormActionState } from "./actions";

const initialState: FormActionState = {};

export function JoinCampaignForm() {
  const [state, formAction, isPending] = useActionState(joinCampaignAction, initialState);

  return (
    <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <TextInput
        label="Invite code"
        name="inviteCode"
        required
        maxLength={20}
        hint={!state.error ? "Ask your DM for their campaign's code." : undefined}
        error={state.error}
        disabled={isPending}
      />
      <Button type="submit" variant="teal" disabled={isPending}>
        {isPending ? "Joining…" : "Join campaign"}
      </Button>
    </form>
  );
}
