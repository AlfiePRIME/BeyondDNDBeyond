"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { Button, TextInput } from "@/ui-components";
import styles from "../auth.module.css";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const supabase = createBrowserSupabaseClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError(signInError.message);
      setSubmitting(false);
      return;
    }

    const next = searchParams.get("next") ?? "/";
    router.push(next);
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <TextInput
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <TextInput
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={error ?? undefined}
      />
      <Button type="submit" disabled={submitting}>
        {submitting ? "Signing in…" : "Sign in"}
      </Button>
      <p className={styles.switchLink}>
        New here? <Link href="/signup">Create an account</Link>
      </p>
    </form>
  );
}
