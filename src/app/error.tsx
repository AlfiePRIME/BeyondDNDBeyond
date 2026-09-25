"use client";

import Link from "next/link";
import { Button, Panel } from "@/ui-components";
import styles from "./status.module.css";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className={styles.page}>
      <Panel title="Something went wrong" tone="pink" glow className={styles.card}>
        <p className={styles.message}>
          This page hit an unexpected error. Trying again usually fixes a dropped connection; if it keeps
          happening, let your DM know.
          {error.digest ? ` (ref ${error.digest})` : null}
        </p>
        <div className={styles.actions}>
          <Button size="sm" variant="teal" onClick={() => reset()}>
            Try again
          </Button>
          <Link href="/" className={styles.link}>
            ← Back home
          </Link>
        </div>
      </Panel>
    </div>
  );
}
