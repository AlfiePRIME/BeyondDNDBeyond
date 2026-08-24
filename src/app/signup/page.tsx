import { Panel, SectionHeader } from "@/ui-components";
import { SignupForm } from "./SignupForm";
import styles from "../auth.module.css";

export default function SignupPage() {
  return (
    <div className={styles.wrap}>
      <Panel title="Create account" tone="pink" glow className={styles.panel}>
        <SectionHeader eyebrow="BeyondDNDBeyond" title="Join the table" />
        <SignupForm />
      </Panel>
    </div>
  );
}
