import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getProfile, type Profile } from "./profiles";

const ORIGINAL_ADMIN_EMAIL = process.env.ADMIN_EMAIL;

afterEach(() => {
  if (ORIGINAL_ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN_EMAIL;
  vi.restoreAllMocks();
});

/** Minimal stub covering exactly the query/auth shapes profiles.ts issues —
 * the same scope as diceTrayPreference.test.ts's own stubClient. `row` is
 * mutated in place by an update, mirroring a real table. */
function stubClient(options: {
  row: Omit<Profile, "id"> & { id: string };
  sessionUser?: { id: string; email: string | null } | null;
  getUserError?: Error;
  updateError?: Error;
  onUpdate?: (row: unknown) => void;
}): { client: SupabaseClient; getUserSpy: ReturnType<typeof vi.fn> } {
  const getUserSpy = vi.fn(async () => ({
    data: { user: options.getUserError ? null : (options.sessionUser ?? null) },
    error: options.getUserError ?? null,
  }));

  const client = {
    auth: { getUser: getUserSpy },
    from: (table: string) => {
      if (table !== "profiles") throw new Error(`unexpected table in stub: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: options.row.id ? { ...options.row } : null, error: null }),
          }),
        }),
        update: (patch: { is_admin: boolean }) => {
          options.onUpdate?.(patch);
          return {
            eq: () => ({
              eq: async () => {
                if (options.updateError) return { error: options.updateError };
                options.row.is_admin = patch.is_admin;
                return { error: null };
              },
            }),
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, getUserSpy };
}

const baseRow: Omit<Profile, "id"> = {
  display_name: "Vex",
  avatar_source: null,
  avatar_ref: null,
  created_at: "",
  ui_preferences: { panelLayout: {} },
  is_admin: false,
};

describe("getProfile", () => {
  it("returns null when no row exists, without touching auth", async () => {
    const { client, getUserSpy } = stubClient({ row: { ...baseRow, id: "" } });
    process.env.ADMIN_EMAIL = "admin@example.test";
    await expect(getProfile(client, "user-1")).resolves.toBeNull();
    expect(getUserSpy).not.toHaveBeenCalled();
  });

  it("is a true no-op for an already-admin profile — never calls auth.getUser", async () => {
    const { client, getUserSpy } = stubClient({
      row: { ...baseRow, id: "user-1", is_admin: true },
    });
    process.env.ADMIN_EMAIL = "admin@example.test";
    const profile = await getProfile(client, "user-1");
    expect(profile?.is_admin).toBe(true);
    expect(getUserSpy).not.toHaveBeenCalled();
  });

  it("skips the admin check entirely when ADMIN_EMAIL is unset", async () => {
    delete process.env.ADMIN_EMAIL;
    const { client, getUserSpy } = stubClient({
      row: { ...baseRow, id: "user-1" },
      sessionUser: { id: "user-1", email: "anyone@example.test" },
    });
    const profile = await getProfile(client, "user-1");
    expect(profile?.is_admin).toBe(false);
    expect(getUserSpy).not.toHaveBeenCalled();
  });

  it("grants is_admin on a fresh, non-admin profile whose session email matches ADMIN_EMAIL", async () => {
    process.env.ADMIN_EMAIL = "admin@example.test";
    const { client } = stubClient({
      row: { ...baseRow, id: "user-1" },
      sessionUser: { id: "user-1", email: "admin@example.test" },
    });
    const profile = await getProfile(client, "user-1");
    expect(profile?.is_admin).toBe(true);
  });

  it("matches ADMIN_EMAIL case-insensitively and trims whitespace", async () => {
    process.env.ADMIN_EMAIL = "  Admin@Example.Test  ";
    const { client } = stubClient({
      row: { ...baseRow, id: "user-1" },
      sessionUser: { id: "user-1", email: "ADMIN@example.test" },
    });
    const profile = await getProfile(client, "user-1");
    expect(profile?.is_admin).toBe(true);
  });

  it("grants a PRE-EXISTING account the next time it logs in after ADMIN_EMAIL is set", async () => {
    // Simulates: this profile row already existed (is_admin false, the
    // column default) before ADMIN_EMAIL was ever configured for this
    // deployment — the realistic path this mechanism exists for.
    process.env.ADMIN_EMAIL = "admin@example.test";
    const { client } = stubClient({
      row: { ...baseRow, id: "veteran-user", is_admin: false },
      sessionUser: { id: "veteran-user", email: "admin@example.test" },
    });
    const profile = await getProfile(client, "veteran-user");
    expect(profile?.is_admin).toBe(true);
  });

  it("does not grant when the session email does not match ADMIN_EMAIL", async () => {
    process.env.ADMIN_EMAIL = "admin@example.test";
    const { client } = stubClient({
      row: { ...baseRow, id: "user-1" },
      sessionUser: { id: "user-1", email: "someone-else@example.test" },
    });
    const profile = await getProfile(client, "user-1");
    expect(profile?.is_admin).toBe(false);
  });

  it("never grants admin when fetching a DIFFERENT user's profile (the roster-loop case)", async () => {
    // The caller's own session matches ADMIN_EMAIL, but the profile being
    // fetched belongs to someone else (e.g. room/page.tsx's roster loop) —
    // must never grant admin onto that other member's row.
    process.env.ADMIN_EMAIL = "admin@example.test";
    const { client } = stubClient({
      row: { ...baseRow, id: "other-member" },
      sessionUser: { id: "the-viewer", email: "admin@example.test" },
    });
    const profile = await getProfile(client, "other-member");
    expect(profile?.is_admin).toBe(false);
  });

  it("does not grant when there is no signed-in session", async () => {
    process.env.ADMIN_EMAIL = "admin@example.test";
    const { client } = stubClient({ row: { ...baseRow, id: "user-1" }, sessionUser: null });
    const profile = await getProfile(client, "user-1");
    expect(profile?.is_admin).toBe(false);
  });

  it("caches the session lookup per SupabaseClient instance across multiple getProfile calls", async () => {
    process.env.ADMIN_EMAIL = "admin@example.test";
    const rowA = { ...baseRow, id: "user-a" };
    const rowB = { ...baseRow, id: "user-b" };
    const getUserSpy = vi.fn(async () => ({
      data: { user: { id: "the-viewer", email: "admin@example.test" } },
      error: null,
    }));
    const client = {
      auth: { getUser: getUserSpy },
      from: (table: string) => {
        if (table !== "profiles") throw new Error(`unexpected table: ${table}`);
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({ data: id === "user-a" ? rowA : rowB, error: null }),
            }),
          }),
          update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        };
      },
    } as unknown as SupabaseClient;

    await getProfile(client, "user-a");
    await getProfile(client, "user-b");
    // Neither row belongs to "the-viewer", so no grant happens either way —
    // the point of this test is solely that the underlying auth lookup was
    // only performed once for the two calls sharing this client instance.
    expect(getUserSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows an update failure — the read still succeeds, un-admin'd", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.ADMIN_EMAIL = "admin@example.test";
    const { client } = stubClient({
      row: { ...baseRow, id: "user-1" },
      sessionUser: { id: "user-1", email: "admin@example.test" },
      updateError: new Error("db down"),
    });
    const profile = await getProfile(client, "user-1");
    expect(profile?.is_admin).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("propagates a real read error rather than silently returning null", async () => {
    const client = {
      auth: { getUser: vi.fn() },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: new Error("db down") }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    await expect(getProfile(client, "user-1")).rejects.toThrow("db down");
  });
});
