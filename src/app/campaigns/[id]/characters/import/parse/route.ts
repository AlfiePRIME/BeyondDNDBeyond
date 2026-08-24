import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { importCharacterSheet, NOT_A_PDF_MESSAGE } from "../lib/runImport";

const MAX_FILE_BYTES = 15 * 1024 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, reason: "server-error", message: "You must be signed in to import a character." },
      { status: 401 }
    );
  }

  const { data: campaign, error } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!campaign) {
    return NextResponse.json(
      { ok: false, reason: "server-error", message: "Campaign not found." },
      { status: 404 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json(
      { ok: false, reason: "not-a-pdf", message: "No file was uploaded." },
      { status: 400 }
    );
  }

  const looksLikePdfName = file.name.toLowerCase().endsWith(".pdf");
  const looksLikePdfType = file.type === "application/pdf";
  if (!looksLikePdfName && !looksLikePdfType) {
    return NextResponse.json({ ok: false, reason: "not-a-pdf", message: NOT_A_PDF_MESSAGE }, { status: 400 });
  }

  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        reason: "not-a-pdf",
        message: "That file is too large — character sheet PDFs are usually well under 15MB.",
      },
      { status: 400 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await importCharacterSheet(bytes);
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
