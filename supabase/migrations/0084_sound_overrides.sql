-- Sound Effects SP2: admin-uploadable replacements for SP1's baked default
-- sound files (src/audio/soundManager.ts's SOUND_KEYS registry, 12 keys —
-- see that file's own top-of-file doc comment, which explicitly designates
-- this migration and resolveSoundUrl() as the intended extension point).
--
-- One row per overridden sound key (sound_key is the primary key — at most
-- one active override per key, matching character_pawns'/campaign_monster_
-- template_overrides' own "at most one current replacement" cardinality).
-- sound_key is a plain text column with a CHECK constraint against the
-- literal registry values, NOT a foreign key — the registry itself is a
-- code-level constant (SOUND_KEYS in src/audio/soundManager.ts), not a
-- database table, so there is nothing to reference. Absence of a row for a
-- key is the overwhelmingly common case and means exactly one thing:
-- playback falls back to SP1's baked default file for that key.
--
-- RLS is intentionally asymmetric, mirroring app_settings' is_app_admin()
-- gate (0072) for writes but NOT its read gate: every connected, authenticated
-- client (every player, not just the DM, not just admins) must be able to
-- resolve which file to actually play during real gameplay, so SELECT is
-- open to any authenticated user. INSERT/UPDATE/DELETE stay admin-only.
create table public.sound_overrides (
  sound_key text primary key
    check (sound_key in (
      'dice_impact',
      'pit_fall',
      'hit_normal',
      'hit_critical',
      'hit_miss',
      'token_move',
      'door_transition',
      'death',
      'rain_loop',
      'wind_loop',
      'thunder',
      'fire_loop'
    )),
  -- A storage object path in the new sound-overrides bucket below. See that
  -- bucket's own comment for why this is a fresh, uniquely-named object per
  -- upload (map-art's 0077 uuid-per-generation convention) rather than a
  -- fixed path replaced in place (avatars'/character-pawns' convention):
  -- soundManager.ts's own bufferCache is keyed by URL string and, unlike a
  -- page-reload-per-view image, an already-open game session can keep a
  -- long-lived AudioBuffer cached from earlier in the same session — a
  -- fixed, reused path could silently keep serving a stale cached buffer
  -- (or a stale HTTP/CDN response) after a re-upload. A fresh path per
  -- upload sidesteps that entirely: the old object is simply left orphaned,
  -- the same "old object left behind, no history any UI needs" posture
  -- campaign_monster_template_overrides' own doc comment already accepts.
  storage_ref text not null,
  updated_at timestamptz not null default now()
);

alter table public.sound_overrides enable row level security;

create policy "any authenticated user can read sound overrides"
  on public.sound_overrides for select
  to authenticated
  using (true);

create policy "an app admin can create sound overrides"
  on public.sound_overrides for insert
  to authenticated
  with check (public.is_app_admin());

create policy "an app admin can update sound overrides"
  on public.sound_overrides for update
  to authenticated
  using (public.is_app_admin())
  with check (public.is_app_admin());

create policy "an app admin can delete sound overrides"
  on public.sound_overrides for delete
  to authenticated
  using (public.is_app_admin());

-- Storage: a NEW bucket, and — confirmed by inspecting every other bucket
-- in supabase/migrations/*.sql — the FIRST one in this codebase with
-- `public = true`. Every existing bucket (avatars, map-assets, npc-
-- portraits, handouts, map-thumbnails, map-references, map-art, character-
-- pawns) is private, read via a short-lived createSignedUrl() minted under
-- the caller's own session. That precedent deliberately does NOT fit here:
-- src/audio/soundManager.ts is a plain, framework-agnostic Web Audio engine
-- with no Supabase client of its own — its loadBuffer() calls a bare
-- `fetch(url)` with no auth header, and caches the resulting AudioBuffer
-- for the whole page lifetime, so a URL that can silently expire is the
-- wrong shape (unlike a display <img> that can just re-mint a fresh signed
-- URL on its next render). This also matches the Task's own explicit
-- instruction: "admin-write only, publicly readable" — every connected
-- client needs this, not just campaign members who can already see some
-- specific map/character (map-art's/character-pawns' scoped posture),
-- so there is no per-object visibility to check at all, only who may WRITE.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sound-overrides',
  'sound-overrides',
  true,
  10485760,
  array['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac']
);

-- Belt-and-braces SELECT policy for anything that still goes through
-- Storage's RLS-checked API surface (e.g. a future `.list()`/`.download()`
-- call) rather than the bucket's own public object endpoint, which already
-- bypasses RLS entirely for a `public = true` bucket. `to public` (the
-- literal Postgres pseudo-role for "every role, including anon") mirrors
-- the bucket's own public flag exactly, rather than narrowing to
-- `authenticated` the way the sound_overrides TABLE's own read policy above
-- deliberately does.
create policy "sound override files are publicly readable"
  on storage.objects for select
  to public
  using (bucket_id = 'sound-overrides');

-- Write access has no per-object ownership to check (unlike map-art/
-- character-pawns, whose paths embed a map_id/character_id the policy
-- extracts via storage.foldername) — this bucket's writes are gated purely
-- on the uploader being an app admin, full stop.
create policy "an app admin can upload sound override files"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'sound-overrides' and public.is_app_admin());

create policy "an app admin can replace sound override files"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'sound-overrides' and public.is_app_admin())
  with check (bucket_id = 'sound-overrides' and public.is_app_admin());

create policy "an app admin can delete sound override files"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'sound-overrides' and public.is_app_admin());
