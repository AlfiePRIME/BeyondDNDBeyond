"use client";

import { useState } from "react";
import Link from "next/link";
import { Canvas } from "@react-three/fiber";
import type { CampaignMember } from "@/data-access";
import { Button } from "@/ui-components";
import { GameTableScene, type CameraMode } from "@/scene-3d";
import styles from "./room.module.css";

export function GameRoom({
  campaignId,
  campaignName,
  members,
  currentUserId,
}: {
  campaignId: string;
  campaignName: string;
  members: CampaignMember[];
  currentUserId: string;
}) {
  const [cameraMode, setCameraMode] = useState<CameraMode>("seat");

  return (
    <div className={styles.room}>
      <Canvas shadows dpr={[1, 2]}>
        <GameTableScene members={members} currentUserId={currentUserId} cameraMode={cameraMode} />
      </Canvas>
      <header className={styles.overlay}>
        <Link href={`/campaigns/${campaignId}`} className={styles.backLink}>
          ← {campaignName}
        </Link>
        <div className={styles.overlayControls}>
          <Button
            size="sm"
            variant={cameraMode === "orbit" ? "teal" : "ghost"}
            onClick={() => setCameraMode((mode) => (mode === "seat" ? "orbit" : "seat"))}
          >
            {cameraMode === "seat" ? "Free camera" : "Return to seat"}
          </Button>
          <span className={styles.roomLabel}>Game Room</span>
        </div>
      </header>
    </div>
  );
}
