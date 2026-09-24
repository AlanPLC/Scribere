import { NextRequest, NextResponse } from "next/server";
import { fetchRawTranscript, getVideoTitle, TranscriptError } from "@/lib/youtube";
import { splitIntoChunks } from "@/lib/coherence";
import { checkRateLimit } from "@/lib/rateLimit";
import { newJobId, saveJob, type TranscribeJob } from "@/lib/jobs";
import { getClientIp } from "@/lib/ip";
import { isSameOrigin } from "@/lib/origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
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

  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json(
      { error: "El servidor no tiene configurada la API key de Groq (GROQ_API_KEY)." },
      { status: 500 }
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

    const chunks = splitIntoChunks(raw.text);

    const job: TranscribeJob = {
      id: newJobId(),
      videoId: raw.videoId,
      lang: raw.lang,
      title,
      rawText: raw.text,
      chunks,
      editedChunks: [],
      currentIndex: 0,
      status: "processing",
      createdAt: Date.now(),
    };
    await saveJob(job);

    return NextResponse.json({
      jobId: job.id,
      videoId: job.videoId,
      lang: job.lang,
      title: job.title,
      rawText: job.rawText,
      totalChunks: chunks.length,
    });
  } catch (err) {
    if (err instanceof TranscriptError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Error desconocido.";
    return NextResponse.json({ error: `Error procesando el video: ${message}` }, { status: 500 });
  }
}
