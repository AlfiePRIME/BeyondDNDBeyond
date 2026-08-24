"use client";

/*
 * Dev-only component showcase — every ui-components export in its main
 * states, so later prompts can see what's available before building
 * screens. No auth on purpose.
 */

import { useState } from "react";
import {
  Badge,
  Button,
  Glitch,
  Modal,
  Panel,
  SectionHeader,
  TextInput,
  VHS,
} from "@/ui-components";
import styles from "./showcase.module.css";

export default function UiShowcasePage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [charName, setCharName] = useState("Vex'ahlia de Rolo");

  return (
    <main className={styles.page}>
      {/* CRT atmosphere — ported effect classes from the tokens file. */}
      <div className="ap-scanlines" aria-hidden />
      <div className="ap-crt-vignette" aria-hidden />

      {/* Hero — deliberate CanvasUI moment: VHS worn-tape playback over the banner. */}
      <VHS
        className={styles.hero}
        speed={0.4}
        wave={0.8}
        scanlines={0.3}
        grain={0.14}
        aberration={2.5}
        bloom={0.45}
      >
        <div className={styles.heroInner}>
          <p className={styles.heroEyebrow}>ui-components / design tokens v1</p>
          <h1 className={styles.heroTitle}>
            Beyond<span className={styles.heroTitleAccent}>DND</span>Beyond
          </h1>
          <p className={styles.heroTagline}>
            The shared neon/CRT component library. Tokens ported verbatim from AlfiePrime
            Hub — purple, pink, and teal on near-black, glow reserved for chrome, body
            copy kept solidly legible for the tabletop surface.
          </p>
          <div className={styles.heroBadges}>
            <Badge tone="teal" pulse>
              session live
            </Badge>
            <Badge tone="purple">tokens locked</Badge>
            <Badge tone="pink">crt</Badge>
          </div>
        </div>
      </VHS>

      <section className={styles.section}>
        <SectionHeader
          eyebrow="interactive"
          title="Buttons"
          actions={<Badge tone="neutral">5 variants × 3 sizes</Badge>}
        />
        <div className={styles.row}>
          <Button>Roll initiative</Button>
          <Button variant="accent">Cast spell</Button>
          <Button variant="teal">Short rest</Button>
          <Button variant="danger">Take damage</Button>
          <Button variant="ghost">Cancel</Button>
        </div>
        <div className={styles.row}>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button disabled>Disabled</Button>
          <Button variant="teal" size="sm" disabled>
            Disabled teal
          </Button>
        </div>
        <p className={styles.caption}>hover / tab-focus for the glow states</p>
      </section>

      <section className={styles.section}>
        <SectionHeader eyebrow="surfaces" title="Panels" />
        <div className={styles.grid}>
          <Panel title="Party status" tone="purple" headerActions={<Badge tone="teal">4/4 up</Badge>}>
            <p>
              Default purple tone. Body copy sits on solid <code>--text</code> over{" "}
              <code>--surface</code> — full contrast, no glow bleeding into content.
            </p>
          </Panel>
          <Panel title="Damage log" tone="pink" glow>
            <p className={styles.mutedCopy}>
              Pink tone with its ambient glow enabled. Use glow sparingly — one or two
              focal panels per screen, not every card.
            </p>
          </Panel>
          <Panel title="Turn tracker" tone="teal">
            <p className={styles.mutedCopy}>
              Teal tone. The 1px energized top edge and mono header label come from the
              ported label conventions.
            </p>
          </Panel>
          <Panel tone="none">
            <p className={styles.mutedCopy}>
              Headerless, tone <code>none</code> — a quiet container for dense tabletop
              content like stat blocks.
            </p>
          </Panel>
        </div>
      </section>

      <section className={styles.section}>
        <SectionHeader eyebrow="forms" title="Text inputs" />
        <div className={styles.stack}>
          <TextInput
            label="Character name"
            value={charName}
            onChange={(event) => setCharName(event.target.value)}
            hint="Filled + controlled — click in to see the focus glow"
          />
          <TextInput label="Campaign" placeholder="e.g. Curse of Strahd" />
          <TextInput
            label="Hit points"
            defaultValue="-3"
            error="HP cannot go below the death threshold"
          />
          <TextInput label="Passive perception" defaultValue="14" disabled />
        </div>
      </section>

      <section className={styles.section}>
        <SectionHeader eyebrow="status" title="Badges" />
        <div className={styles.row}>
          <Badge tone="purple">arcane</Badge>
          <Badge tone="pink">charmed</Badge>
          <Badge tone="teal">connected</Badge>
          <Badge tone="orange">concentration</Badge>
          <Badge tone="red">bloodied</Badge>
          <Badge>neutral</Badge>
          <Badge tone="teal" pulse>
            dm online
          </Badge>
          <Badge tone="red" pulse>
            combat
          </Badge>
        </div>
      </section>

      <section className={styles.section}>
        <SectionHeader
          eyebrow="typography"
          title="Section headers"
          actions={<Button size="sm" variant="ghost">Header action</Button>}
        />
        <SectionHeader title="Plain, no eyebrow" as="h3" />
        <SectionHeader eyebrow="decorative glitch layers" title="Glitched title" as="h3" glitch />
        <p className={styles.caption}>
          the glitch blips reuse the ported glitch-a / glitch-b keyframes (watch for a few
          seconds)
        </p>
      </section>

      <section className={styles.section}>
        <SectionHeader eyebrow="overlay" title="Modal" />
        <div className={styles.row}>
          <Button onClick={() => setModalOpen(true)}>Open modal</Button>
        </div>
        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Delete character"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setModalOpen(false)}>
                Keep them
              </Button>
              <Button variant="danger" size="sm" onClick={() => setModalOpen(false)}>
                Delete forever
              </Button>
            </>
          }
        >
          <p>
            This will permanently delete the character and all of their inventory,
            spell slots, and session history. Escape, the backdrop, or the × also
            close this dialog.
          </p>
        </Modal>
      </section>

      <section className={styles.section}>
        <SectionHeader eyebrow="canvasui" title="WebGL effects" />
        <div className={styles.grid}>
          <Glitch interval={4} duration={0.35} intensity={0.9}>
            <Panel title="Glitch — broadcast bursts" tone="pink">
              <div className={styles.glitchDemo}>
                <div className={styles.glitchDemoTitle}>Signal lost</div>
                <p className={styles.mutedCopy}>
                  CanvasUI Glitch wraps this panel: periodic tear/RGB-split bursts,
                  content stays interactive. Falls back to a clean render where
                  html-in-canvas is unsupported.
                </p>
              </div>
            </Panel>
          </Glitch>
          <VHS speed={0.5} scanlines={0.4} grain={0.2} wave={1.2} aberration={3}>
            <Panel title="VHS — worn tape" tone="teal">
              <div className={styles.glitchDemo}>
                <div className={styles.glitchDemoTitle}>Now playing</div>
                <p className={styles.mutedCopy}>
                  CanvasUI VHS over a panel: tape wave, chroma bleed, grain, and
                  scanlines. Reserve for hero moments — not every surface.
                </p>
              </div>
            </Panel>
          </VHS>
        </div>
      </section>
    </main>
  );
}
