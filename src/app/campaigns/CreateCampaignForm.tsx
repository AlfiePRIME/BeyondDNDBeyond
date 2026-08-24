"use client";

import { useActionState } from "react";
import { Button, TextInput } from "@/ui-components";
import { createCampaignAction, type FormActionState } from "./actions";

const initialState: FormActionState = {};

export function CreateCampaignForm() {
  const [state, formAction, isPending] = useActionState(createCampaignAction, initialState);

  return (
    <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <TextInput
        label="Campaign name"
        name="name"
        required
        maxLength={80}
        error={state.error}
        disabled={isPending}
      />
      <Button type="submit" variant="accent" disabled={isPending}>
        {isPending ? "Creating…" : "Create campaign"}
      </Button>
    </form>
  );
}
