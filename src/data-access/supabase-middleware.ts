import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { requireEnv } from "./env";

const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
const supabaseAnonKey = requireEnv(
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

/**
 * Refreshes the session (if needed) for a request in middleware and reports
 * back whether a user is currently authenticated. Route protection logic
 * itself lives in middleware.ts — this just handles the Supabase-specific
 * plumbing, kept in data-access per the module boundary.
 */
export async function refreshSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Always use getUser() here, not getSession() — getUser() revalidates the
  // token against Supabase Auth rather than trusting an unverified cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { response, user };
}
