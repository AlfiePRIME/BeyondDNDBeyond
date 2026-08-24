"use client";

import Link from "next/link";
import { Canvas } from "@react-three/fiber";
import { GameTableScene } from "@/scene-3d";
import styles from "./room.module.css";

export function GameRoom({
  campaignId,
  campaignName,
}: {
  campaignId: string;
  campaignName: string;
}) {
  return (
    <div className={styles.room}>
      <Canvas shadows dpr={[1, 2]}>
        <GameTableScene />
      </Canvas>
      <header className={styles.overlay}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
          ← {campaignName}
        </Link>
        <span className={styles.roomLabel}>Game Room</span>
      </header>
    </div>
  );
}
