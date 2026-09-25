"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui-components";
import { RosterCanvas, RosterDieSlot, RosterModelSlot } from "@/scene-3d";
import styles from "./InitiativeRoster.module.css";

export interface RosterEntry {
  combatantId: string;
  name: string;
  side: "party" | "enemies";
  modelUrl: string | null;
  /** Accent for the picture fallback (the player's token color). */
  color: string | null;
  initiative: number | null;
  /** The natural d20 behind `initiative`, when it was rolled. */
  naturalRoll: number | null;
  /** The viewer may roll for this combatant (their own PC, or the DM). */
  canRoll: boolean;
}

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

function Row({
  entry,
  rolling,
  onRoll,
}: {
  entry: RosterEntry;
  rolling: boolean;
  onRoll: (combatantId: string) => void;
}) {
  const rolled = entry.initiative !== null;
  return (
    <li
      className={`${styles.row} ${entry.side === "enemies" ? styles.rowEnemy : ""}`}
      data-testid={`initiative-row-${entry.combatantId}`}
      data-rolled={rolled ? "true" : "false"}
    >
      <div className={styles.portrait}>
        {entry.modelUrl ? (
          <RosterModelSlot modelUrl={entry.modelUrl} className={styles.portraitView} />
        ) : (
          <span
            className={styles.picture}
            style={entry.color ? { background: entry.color } : undefined}
            aria-hidden="true"
          >
            {initials(entry.name)}
          </span>
        )}
      </div>
      <span className={styles.name}>{entry.name}</span>
      <div className={styles.dieSlot}>
        {rolled && entry.naturalRoll !== null ? (
          <RosterDieSlot
            rollId={`initiative-${entry.combatantId}-${entry.initiative}`}
            result={entry.naturalRoll}
            className={styles.dieView}
          />
        ) : null}
      </div>
      <div className={styles.result}>
        {rolled ? (
          <span className={styles.total} data-testid={`initiative-total-${entry.combatantId}`}>
            {entry.initiative}
          </span>
        ) : entry.canRoll ? (
          <Button
            size="sm"
            variant="primary"
            disabled={rolling}
            onClick={() => onRoll(entry.combatantId)}
            data-testid={`initiative-roll-${entry.combatantId}`}
          >
            {rolling ? "Rolling…" : "Roll"}
          </Button>
        ) : (
          <span className={styles.waiting}>waiting…</span>
        )}
      </div>
    </li>
  );
}

/**
 * The "Roll for initiative!" screen that opens when combat starts: the party
 * lined up against the enemies, each with their model (or a picture), and a
 * 3D d20 that rolls and lands on each result as it comes in. Anyone who
 * hasn't rolled when the countdown runs out is rolled for automatically (by
 * the DM's client — see GameRoom), then round 1 begins.
 */
export function InitiativeRoster({
  entries,
  deadline,
  isDM,
  rollingIds,
  onRoll,
  onRollAllEnemies,
  onBeginNow,
}: {
  entries: RosterEntry[];
  deadline: string | null;
  isDM: boolean;
  rollingIds: ReadonlySet<string>;
  onRoll: (combatantId: string) => void;
  onRollAllEnemies: () => void;
  onBeginNow: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const deadlineMs = deadline ? new Date(deadline).getTime() : null;
  const secondsLeft = deadlineMs === null ? null : Math.max(0, Math.ceil((deadlineMs - now) / 1000));
  const fraction = deadlineMs === null ? 0 : Math.max(0, Math.min(1, (deadlineMs - now) / 15000));
  const party = entries.filter((entry) => entry.side === "party");
  const enemies = entries.filter((entry) => entry.side === "enemies");
  const allRolled = entries.length > 0 && entries.every((entry) => entry.initiative !== null);
  const unrolledEnemies = enemies.filter((entry) => entry.initiative === null && entry.canRoll);

  return (
    <div className={styles.overlay} data-testid="initiative-roster" ref={containerRef}>
      <div className={styles.card}>
        <header className={styles.header}>
          <h2 className={styles.title}>Roll for initiative!</h2>
          <p className={styles.subtitle} data-testid="initiative-countdown">
            {allRolled
              ? "Everyone's in — the fight begins…"
              : secondsLeft === null
                ? "Roll your d20 to see who acts first."
                : secondsLeft > 0
                  ? `Roll within ${secondsLeft}s — or the dice roll for you.`
                  : "Rolling for anyone who hasn't…"}
          </p>
          <div className={styles.timer} aria-hidden="true">
            <span style={{ transform: `scaleX(${allRolled ? 0 : fraction})` }} />
          </div>
        </header>

        <div className={styles.sides}>
          <section className={styles.side} aria-label="The party">
            <h3 className={styles.sideTitle}>The party</h3>
            <ul className={styles.list}>
              {party.map((entry) => (
                <Row key={entry.combatantId} entry={entry} rolling={rollingIds.has(entry.combatantId)} onRoll={onRoll} />
              ))}
              {party.length === 0 ? <li className={styles.empty}>No party members in this fight</li> : null}
            </ul>
          </section>
          <div className={styles.versus} aria-hidden="true">
            vs
          </div>
          <section className={styles.side} aria-label="The enemies">
            <h3 className={`${styles.sideTitle} ${styles.sideTitleEnemy}`}>The enemies</h3>
            <ul className={styles.list}>
              {enemies.map((entry) => (
                <Row key={entry.combatantId} entry={entry} rolling={rollingIds.has(entry.combatantId)} onRoll={onRoll} />
              ))}
              {enemies.length === 0 ? <li className={styles.empty}>No enemies in this fight</li> : null}
            </ul>
          </section>
        </div>

        {isDM ? (
          <footer className={styles.footer}>
            <Button
              size="sm"
              variant="accent"
              disabled={unrolledEnemies.length === 0}
              onClick={onRollAllEnemies}
              data-testid="initiative-roll-all-enemies"
            >
              Roll for all enemies
            </Button>
            <Button size="sm" variant="primary" onClick={onBeginNow} data-testid="initiative-begin-now">
              {allRolled ? "Begin round 1 ▸" : "Roll the rest & begin ▸"}
            </Button>
          </footer>
        ) : null}
      </div>
      <RosterCanvas eventSource={containerRef} />
    </div>
  );
}
