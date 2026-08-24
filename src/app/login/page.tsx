import { Suspense } from "react";
import { Panel, SectionHeader } from "@/ui-components";
import { LoginForm } from "./LoginForm";
import styles from "../auth.module.css";

export default function LoginPage() {
  return (
    <div className={styles.wrap}>
      <Panel title="Sign in" tone="purple" glow className={styles.panel}>
        <SectionHeader eyebrow="BeyondDNDBeyond" title="Welcome back" />
        <Suspense>
          <LoginForm />
        </Suspense>
      </Panel>
    </div>
  );
}
