import { NextResponse } from "next/server";

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { ok: false, error: "NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set" },
      { status: 500 }
    );
  }

  try {
    // The gateway (Envoy/Kong) requires an apikey header on every proxied
    // route, including this health check — a plain fetch with no headers
    // gets a 401 even though the service itself is healthy.
    const res = await fetch(`${supabaseUrl}/auth/v1/health`, {
      cache: "no-store",
      headers: { apikey: anonKey },
    });

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Supabase auth health check returned ${res.status}` },
        { status: 502 }
      );
    }

    const body = await res.json();
    return NextResponse.json({ ok: true, supabaseAuth: body });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Could not reach Supabase at ${supabaseUrl} — is the Docker Compose stack running?`,
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }
}
