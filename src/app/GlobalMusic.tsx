"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  getDebugSnapshot,
  setMasterVolume,
  setMuted,
  startLoop,
  stopLoop,
  subscribeDebugState,
  SOUND_KEYS,
} from "@/audio";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { getProfile, DEFAULT_SOUND_SETTINGS } from "@/data-access";

// Suppressed only in the Game Room (its own calm_music/combat_music take
// over — GameRoom.tsx's own applyGameMusic effect) and the map editor (a
// focused editing task, not somewhere ambient menu music should keep
// playing) — everywhere else (Lobby, campaigns list, account, character
// pages, login/signup, etc) plays lobby_music, per the project owner's own
// explicit brief.
const GAME_ROOM_PATTERN = /^\/campaigns\/[^/]+\/room(\/|$)/;
const MAP_EDITOR_PATTERN = /^\/campaigns\/[^/]+\/maps\/[^/]+\/edit(\/|$)/;

function shouldPlayLobbyMusic(pathname: string | null): boolean {
  if (!pathname) return false;
  return !GAME_ROOM_PATTERN.test(pathname) && !MAP_EDITOR_PATTERN.test(pathname);
}

/**
 * Mounted exactly once, unconditionally, in the root layout — supersedes
 * the earlier Lobby-page-only version of this same effect (previously
 * LobbyPresence.tsx's own useEffect). usePathname() re-evaluates on every
 * client-side navigation, so a single startLoop/stopLoop pair here covers
 * every route without needing a copy of this effect per page.
 * startLoop/stopLoop are idempotent, so rapid navigation between two
 * lobby-music-eligible routes never re-triggers a fade, and a React Strict
 * Mode dev-mode double-mount is harmless — the same reasoning SP9's
 * weather loops and gameMusic.ts already rely on.
 */
export function GlobalMusic() {
  const pathname = usePathname();

  useEffect(() => {
    if (shouldPlayLobbyMusic(pathname)) {
      void startLoop(SOUND_KEYS.LOBBY_MUSIC);
    } else {
      stopLoop(SOUND_KEYS.LOBBY_MUSIC);
    }
  }, [pathname]);

  // The caller's persisted volume/mute preference, applied ONCE here (this
  // component's own client-side fetch — the root layout stays a plain
  // Server Component with no per-request user context to prop-drill this
  // from) so a muted/quieted user doesn't get lobby_music at full volume
  // on their very first navigation of a session, on WHATEVER page that
  // happens to be. Silently skipped if no user is signed in yet
  // (login/signup) — defaults apply until a real preference exists.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = createBrowserSupabaseClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      const profile = await getProfile(supabase, user.id).catch(() => null);
      if (!profile || cancelled) return;
      const settings = profile.ui_preferences?.soundSettings ?? DEFAULT_SOUND_SETTINGS;
      setMasterVolume(settings.volume);
      setMuted(settings.muted);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hidden render-state mirror, the same visionDebug/sound-manager-debug
  // convention SoundControl.tsx already establishes for the Game Room —
  // mounted globally here too so a page with no SoundControl of its own
  // (everywhere except the Game Room) still has a real way to read the
  // sound manager's actual state (scripts/db/verify-game-music.mjs's own
  // Lobby-page checks). A page that ALSO mounts SoundControl (the Game
  // Room) ends up with two matching mirrors reporting the same real
  // global state — harmless duplication, not a correctness issue.
  const [debugSnapshot, setDebugSnapshot] = useState(() => getDebugSnapshot());
  useEffect(() => subscribeDebugState(() => setDebugSnapshot(getDebugSnapshot())), []);
  useEffect(() => {
    const interval = setInterval(() => setDebugSnapshot(getDebugSnapshot()), 200);
    return () => clearInterval(interval);
  }, []);

  return (
    <div data-testid="sound-manager-debug" hidden>
      {JSON.stringify(debugSnapshot)}
    </div>
  );
}
