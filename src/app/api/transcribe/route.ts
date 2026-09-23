import { NextRequest, NextResponse } from "next/server";
import { fetchRawTranscript, getVideoTitle, TranscriptError } from "@/lib/youtube";
import { addCoherence, QuotaExceededError } from "@/lib/coherence";
import { checkRateLimit } from "@/lib/rateLimit";
import { hasQuotaRemaining } from "@/lib/quota";
import { getClientIp } from "@/lib/ip";
import { isSameOrigin } from "@/lib/origin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Defense-in-depth against casual scripted abuse hitting the API directly
  // from another site. Doesn't stop a determined bot that spoofs headers —
  // that's what the per-IP rate limit below is for.
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Origen no permitido." }, { status: 403 });
  }

  const ip = getClientIp(req);
  const rateLimit = await checkRateLimit("transcribe", ip);
  if (!rateLimit.allowed) {
    const message =
      rateLimit.reason === "burst"
        ? "Estás pidiendo transcripciones muy seguido. Esperá unos segundos y probá de nuevo."
        : `Alcanzaste el límite de transcripciones por hora. Probá de nuevo en ~${Math.ceil(
            rateLimit.resetInMs / 60000
          )} min.`;
    return NextResponse.json({ error: message }, { status: 429 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "El servidor no tiene configurada la API key de Groq (GROQ_API_KEY)." },
      { status: 500 }
    );
  }

  const quota = await hasQuotaRemaining();
  if (!quota.ok) {
    return NextResponse.json(
      {
        error:
          "Se agotó la cuota compartida de IA por ahora (la usan todos los que visitan el sitio). Probá de nuevo más tarde.",
      },
      { status: 503 }
    );
  }

  let body: { url?: string; lang?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido." }, { status: 400 });
  }

  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json({ error: "Falta la URL del video." }, { status: 400 });
  }

  try {
    const [raw, title] = await Promise.all([
      fetchRawTranscript(body.url, body.lang),
      getVideoTitle(body.url).catch(() => ""),
    ]);
    const coherent = await addCoherence(raw.text, apiKey, title);

    return NextResponse.json({
      videoId: raw.videoId,
      lang: raw.lang,
      rawText: raw.text,
      coherentText: coherent.text,
      remaining: rateLimit.remaining,
    });
  } catch (err) {
    if (err instanceof TranscriptError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof QuotaExceededError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : "Error desconocido.";
    return NextResponse.json({ error: `Error procesando el video: ${message}` }, { status: 500 });
  }
}
