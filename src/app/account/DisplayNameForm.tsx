"use client";

import { useActionState } from "react";
import { Button, TextInput } from "@/ui-components";
import { updateDisplayNameAction } from "./actions";
import type { FormActionState } from "../actions";
import styles from "./account.module.css";

const initialState: FormActionState = {};

export function DisplayNameForm({ initialDisplayName }: { initialDisplayName: string }) {
  const [state, formAction, isPending] = useActionState(updateDisplayNameAction, initialState);

  return (
    <form action={formAction} className={styles.displayNameForm}>
      <TextInput
        label="Display name"
        name="displayName"
        autoComplete="nickname"
        required
        maxLength={40}
        defaultValue={initialDisplayName}
        hint={!state.error ? "This is what the rest of the table will see you as." : undefined}
        error={state.error}
        disabled={isPending}
      />
      <div>
        <Button type="submit" variant="teal" disabled={isPending}>
          {isPending ? "Saving…" : "Save name"}
        </Button>
      </div>
    </form>
  );
}
