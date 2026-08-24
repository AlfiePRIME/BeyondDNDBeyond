"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { Button, TextInput } from "@/ui-components";
import styles from "../auth.module.css";

export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const supabase = createBrowserSupabaseClient();
    const { error: signUpError } = await supabase.auth.signUp({ email, password });

    if (signUpError) {
      setError(signUpError.message);
      setSubmitting(false);
      return;
    }

    // New account has no profile row yet — the root page (once middleware
    // lets the request through) redirects on to /profile-setup.
    router.push("/");
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
        autoComplete="new-password"
        minLength={8}
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint={!error ? "At least 8 characters" : undefined}
        error={error ?? undefined}
      />
      <Button type="submit" variant="accent" disabled={submitting}>
        {submitting ? "Creating account…" : "Create account"}
      </Button>
      <p className={styles.switchLink}>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </form>
  );
}
