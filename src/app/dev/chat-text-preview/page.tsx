"use client";

/*
 * Dev-only ChatText preview (Chat & Summary B2) — the ui-showcase/
 * dice-showcase precedent applied to chat formatting: every representative
 * format-code combination the parser (src/ui-components/chatFormatting.ts)
 * supports, rendered through the ACTUAL production ChatText component, so
 * there's one page to eyeball colors/weights/decorations/obfuscation
 * against and one page scripts/db/verify-chat-formatting.mjs can drive.
 * No auth beyond being a signed-in user, same as ui-showcase/dice-showcase
 * (proxy.ts still requires a session for any non-public route; there's no
 * additional role/campaign check on top of that here).
 *
 * B3 (floating chat bubble) and B4 (chat log panel) are the real in-Game-
 * Room chat surfaces — this page exists only to exercise ChatText in
 * isolation, not as a preview of either of those.
 */

import { ChatText } from "@/ui-components";
import styles from "./chat-text-preview.module.css";

const COLOR_SAMPLES: readonly { code: string; label: string; testId: string }[] = [
  { code: "&0", label: "black (standard)", testId: "sample-color-black" },
  { code: "&1", label: "blue (standard)", testId: "sample-color-blue" },
  { code: "&2", label: "green (standard)", testId: "sample-color-green" },
  { code: "&3", label: "teal (app accent)", testId: "sample-color-teal" },
  { code: "&4", label: "red (app accent)", testId: "sample-color-red" },
  { code: "&5", label: "purple (app accent)", testId: "sample-color-purple" },
  { code: "&6", label: "orange (app accent)", testId: "sample-color-orange" },
  { code: "&7", label: "gray (standard)", testId: "sample-color-gray" },
  { code: "&8", label: "dark gray (standard)", testId: "sample-color-dark-gray" },
  { code: "&9", label: "pink (app accent)", testId: "sample-color-pink" },
  { code: "&a", label: "accent / lavender (app accent)", testId: "sample-color-accent" },
  { code: "&f", label: "white / default (app accent)", testId: "sample-color-white" },
];

// "Several obfuscated messages visible at once" stress case — every one of
// these mounts its own ChatText/obfuscated span, but they all share exactly
// ONE setInterval underneath (chatObfuscationClock.ts), not one each.
const STRESS_OBFUSCATED_COUNT = 24;

export default function ChatTextPreviewPage() {
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>ChatText preview</h1>
      <p className={styles.subtitle}>
        Every format code chatFormatting.ts supports, rendered through the real ChatText
        component. Dev-only — not a preview of the floating chat bubble (B3) or the chat log
        panel (B4), which don&apos;t exist yet.
      </p>

      <section className={styles.section} data-testid="section-colors">
        <h2 className={styles.sectionTitle}>Colors</h2>
        <div className={styles.list}>
          {COLOR_SAMPLES.map(({ code, label, testId }) => (
            <div key={code} className={styles.row} data-testid={testId}>
              <ChatText text={`${code}${label}`} />
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section} data-testid="section-formatting">
        <h2 className={styles.sectionTitle}>Bold / italic / underline / strikethrough</h2>
        <div className={styles.list}>
          <div className={styles.row} data-testid="sample-bold">
            <ChatText text="&lBold text" />
          </div>
          <div className={styles.row} data-testid="sample-italic">
            <ChatText text="&oItalic text" />
          </div>
          <div className={styles.row} data-testid="sample-underline">
            <ChatText text="&nUnderlined text" />
          </div>
          <div className={styles.row} data-testid="sample-strikethrough">
            <ChatText text="&mStrikethrough text" />
          </div>
          <div className={styles.row} data-testid="sample-combined">
            <ChatText text="&4&l&nBold underlined red" />
          </div>
        </div>
      </section>

      <section className={styles.section} data-testid="section-malformed">
        <h2 className={styles.sectionTitle}>Malformed / unknown codes</h2>
        <div className={styles.list}>
          <div className={styles.row} data-testid="sample-malformed">
            <ChatText text="&zUnknown code stays literal" />
          </div>
          <div className={styles.row} data-testid="sample-trailing-amp">
            <ChatText text="Trailing ampersand&" />
          </div>
        </div>
      </section>

      <section className={styles.section} data-testid="section-obfuscated">
        <h2 className={styles.sectionTitle}>Obfuscated (single)</h2>
        <div className={styles.row} data-testid="sample-obfuscated-single">
          <ChatText text="&kSecretMessage" />
        </div>
      </section>

      <section className={styles.section} data-testid="section-realistic">
        <h2 className={styles.sectionTitle}>Realistic multi-code message</h2>
        <div className={styles.row} data-testid="sample-realistic">
          <ChatText text="&4Hello &lworld&r, this is &3teal&r and &kobfuscated&r text." />
        </div>
      </section>

      <section className={styles.section} data-testid="section-stress">
        <h2 className={styles.sectionTitle}>
          Obfuscated stress test ({STRESS_OBFUSCATED_COUNT} simultaneous messages)
        </h2>
        <div className={styles.list} data-testid="stress-obfuscated">
          {Array.from({ length: STRESS_OBFUSCATED_COUNT }, (_, i) => (
            <div key={i} className={styles.row} data-testid={`stress-obfuscated-${i}`}>
              <ChatText text={`&kobfuscated message number ${i}`} />
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
