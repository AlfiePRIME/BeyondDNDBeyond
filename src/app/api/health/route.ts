import { NextResponse } from "next/server";

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  if (!supabaseUrl) {
    return NextResponse.json(
      { ok: false, error: "NEXT_PUBLIC_SUPABASE_URL is not set" },
      { status: 500 }
    );
  }

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/health`, {
      cache: "no-store",
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
