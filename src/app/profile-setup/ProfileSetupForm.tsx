"use client";

import { Button, TextInput } from "@/ui-components";
import { completeProfileSetup } from "./actions";
import styles from "../auth.module.css";

export function ProfileSetupForm({ error }: { error?: string }) {
  return (
    <form className={styles.form} action={completeProfileSetup}>
      <TextInput
        label="Display name"
        name="displayName"
        autoComplete="nickname"
        required
        maxLength={40}
        hint={!error ? "This is what the rest of the table will see you as." : undefined}
        error={error}
      />
      <Button type="submit" variant="teal">
        Continue
      </Button>
    </form>
  );
}
