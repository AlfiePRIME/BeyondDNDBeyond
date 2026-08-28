"use client";

import { useActionState, useState } from "react";
import { Button, Select, TextInput } from "@/ui-components";
import { updateAppSettingsAction, type AdminSettingsActionState } from "./actions";
import type { AppSettings } from "@/data-access";
import styles from "./admin.module.css";

const initialState: AdminSettingsActionState = {};

export interface AdminSettingsFormProps {
  initialSettings: AppSettings;
}

/**
 * The provider/settings form itself. openaiApiKey's masked field NEVER
 * receives the stored key's real value from the server (getAppSettings
 * only ever hands this component `openaiApiKeySet: boolean` — see
 * data-access/appSettings.ts) — it starts empty regardless of whether a
 * key is already saved, and only ever SENDS a value forward (to replace
 * the stored key) or a "clear" flag; leaving it blank and unchecked keeps
 * whatever is already saved untouched.
 */
export function AdminSettingsForm({ initialSettings }: AdminSettingsFormProps) {
  const [state, formAction, isPending] = useActionState(updateAppSettingsAction, initialState);
  const [keyInput, setKeyInput] = useState("");
  const [clearKey, setClearKey] = useState(false);

  // A fresh, successful save always leaves the masked field with nothing
  // more to say about the just-submitted key — reset the transient local
  // input/checkbox so a second look at the form doesn't show stale intent
  // (e.g. a "clear" checkbox still ticked after the clear already applied).
  // Adjusting state during render (comparing against the last STATE OBJECT
  // this component has actually seen) rather than in a useEffect, per
  // React's own "you might not need an effect" guidance — useActionState
  // hands back a new `state` object identity on every dispatch, so this
  // only ever fires once per real submission, not on every render.
  const [lastHandledState, setLastHandledState] = useState(state);
  if (state !== lastHandledState) {
    setLastHandledState(state);
    if (state.success) {
      setKeyInput("");
      setClearKey(false);
    }
  }

  const openaiApiKeySet = initialSettings.openaiApiKeySet;

  return (
    <form action={formAction} className={styles.form} data-testid="admin-settings-form">
      <Select
        label="AI provider"
        name="activeProvider"
        defaultValue={initialSettings.activeProvider}
        disabled={isPending}
        data-testid="admin-provider-select"
      >
        <option value="anthropic">Anthropic</option>
        <option value="openai">OpenAI</option>
        <option value="ollama">Ollama</option>
      </Select>

      <TextInput
        label="OpenAI API key"
        name="openaiApiKey"
        type="password"
        autoComplete="off"
        placeholder={openaiApiKeySet ? "•••• (set)" : "Not set"}
        value={keyInput}
        onChange={(e) => {
          setKeyInput(e.target.value);
          if (e.target.value) setClearKey(false);
        }}
        disabled={isPending || clearKey}
        hint={
          openaiApiKeySet
            ? "A key is currently set — leave this blank to keep it, or enter a new key to replace it."
            : "No key saved yet."
        }
        data-testid="admin-openai-key-input"
      />

      {openaiApiKeySet ? (
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            name="clearOpenaiKey"
            checked={clearKey}
            onChange={(e) => {
              setClearKey(e.target.checked);
              if (e.target.checked) setKeyInput("");
            }}
            disabled={isPending}
            data-testid="admin-clear-openai-key"
          />
          Remove the saved key
        </label>
      ) : null}

      <TextInput
        label="Ollama host URL"
        name="ollamaHostUrl"
        type="text"
        autoComplete="off"
        placeholder="http://localhost:11434"
        defaultValue={initialSettings.ollamaHostUrl ?? ""}
        disabled={isPending}
        data-testid="admin-ollama-host-input"
      />

      <TextInput
        label="Ollama model"
        name="ollamaModel"
        type="text"
        autoComplete="off"
        placeholder="llama3"
        defaultValue={initialSettings.ollamaModel ?? ""}
        disabled={isPending}
        data-testid="admin-ollama-model-input"
      />

      {state.error ? (
        <p role="alert" className={styles.errorText} data-testid="admin-settings-error">
          {state.error}
        </p>
      ) : state.success ? (
        <p className={styles.savedText} data-testid="admin-settings-saved">
          Saved.
        </p>
      ) : null}

      <div>
        <Button type="submit" variant="teal" disabled={isPending} data-testid="admin-settings-save-button">
          {isPending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}
