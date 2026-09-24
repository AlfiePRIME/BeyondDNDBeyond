import Link from "next/link";
import { Panel } from "@/ui-components";
import styles from "./status.module.css";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <div className={styles.page}>
      <Panel title="Lost in the dungeon" tone="pink" glow className={styles.card}>
        <p className={styles.code}>404</p>
        <p className={styles.message}>
          There&apos;s nothing here — the link may be mistyped, or it points at something that was deleted or that
          you&apos;re not a member of.
        </p>
        <div className={styles.actions}>
          <Link href="/" className={styles.link}>
            ← Back to the Lobby
          </Link>
          <Link href="/campaigns" className={styles.link}>
            Your campaigns
          </Link>
        </div>
      </Panel>
    </div>
  );
}
