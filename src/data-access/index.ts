// Public entry point for the data-access module — the environment-agnostic
// parts. This is the ONLY module allowed to import @supabase/supabase-js
// (or @supabase/ssr) directly — enforced by eslint-plugin-boundaries (see
// eslint.config.mjs). Every other module goes through here (or one of the
// sub-entry-points below) for persistence.
//
// Three additional entry points exist for code that Next.js restricts to a
// specific runtime — importing them from this main barrel would leak
// server/edge-only code (e.g. next/headers) into client bundles and break
// the build:
//   @/data-access/supabase-server     — Server Components/Actions/Route Handlers
//   @/data-access/supabase-browser    — Client Components
//   @/data-access/supabase-middleware — Edge Middleware
//
// Note on client creation generally: there is no shared/singleton Supabase
// client — each of the three create*Client functions builds a fresh
// instance per call. A single shared instance would leak one user's
// session/cookies into another user's request on the server.
export { getProfile, upsertProfile, isProfileComplete, type Profile } from "./profiles";
export {
  listCampaignsForUser,
  createCampaign,
  joinCampaignByInviteCode,
  isDM,
  listCampaignMembers,
  transferDM,
  type Campaign,
  type CampaignRole,
  type CampaignMembership,
  type CampaignMember,
} from "./campaigns";
export {
  createCharacter,
  listCharactersForCampaign,
  type Character,
  type CreateCharacterParams,
  type InventoryItem,
  type KnownSpell,
} from "./characters";

export const MODULE_NAME = "data-access" as const;
