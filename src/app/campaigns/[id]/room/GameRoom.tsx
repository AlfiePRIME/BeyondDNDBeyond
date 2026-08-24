"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Canvas } from "@react-three/fiber";
import { subscribeToProfileChanges } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { Button } from "@/ui-components";
import { GameTableScene, type CameraMode } from "@/scene-3d";
import { resolveAvatarUrl, type RoomMember } from "./avatar-url";
import styles from "./room.module.css";

export function GameRoom({
  campaignId,
  campaignName,
  members,
  currentUserId,
}: {
  campaignId: string;
  campaignName: string;
  members: RoomMember[];
  currentUserId: string;
}) {
  const [cameraMode, setCameraMode] = useState<CameraMode>("seat");
  const [roster, setRoster] = useState<RoomMember[]>(members);
  // Render-time reset (not an effect) when the server hands down a fresh
  // member list — react.dev's "adjusting state when a prop changes" pattern.
  const [prevMembers, setPrevMembers] = useState(members);
  if (prevMembers !== members) {
    setPrevMembers(members);
    setRoster(members);
  }

  // Live avatar sync: a postgres_changes feed on profiles (see data-access's
  // subscribeToProfileChanges), not campaign presence — presence only covers
  // clients connected to this room's channel, and the change we care about
  // typically comes from the /account page in another tab or device.
  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    const memberIds = new Set(members.map((member) => member.user_id));
    return subscribeToProfileChanges(supabase, async (profile) => {
      if (!memberIds.has(profile.id)) return;
      const avatarUrl = await resolveAvatarUrl(supabase, profile.avatar_source, profile.avatar_ref);
      setRoster((prev) =>
        prev.map((member) =>
          member.user_id === profile.id ? { ...member, avatar_url: avatarUrl } : member
        )
      );
    });
  }, [members]);

  return (
    <div className={styles.room}>
      <Canvas shadows dpr={[1, 2]}>
        <GameTableScene members={roster} currentUserId={currentUserId} cameraMode={cameraMode} />
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
