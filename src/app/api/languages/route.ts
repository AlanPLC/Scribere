import { NextRequest, NextResponse } from "next/server";
import { listAvailableLanguages, TranscriptError } from "@/lib/youtube";
import { checkRateLimit } from "@/lib/rateLimit";
import { getClientIp } from "@/lib/ip";
import { isSameOrigin } from "@/lib/origin";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Origen no permitido." }, { status: 403 });
  }

  const ip = getClientIp(req);
  const rateLimit = await checkRateLimit("lookup", ip);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Estás haciendo demasiadas consultas. Esperá un momento y probá de nuevo." },
      { status: 429 }
    );
  }

  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido." }, { status: 400 });
  }

  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json({ error: "Falta la URL del video." }, { status: 400 });
  }

  try {
    const { videoId, title, languages } = await listAvailableLanguages(body.url);
    return NextResponse.json({ videoId, title, languages });
  } catch (err) {
    if (err instanceof TranscriptError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Error desconocido.";
    return NextResponse.json({ error: `Error consultando el video: ${message}` }, { status: 500 });
  }
}
