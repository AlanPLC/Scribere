import { NextRequest, NextResponse } from "next/server";
import { buildSystemPrompt, processChunk } from "@/lib/coherence";
import { hasQuotaRemaining } from "@/lib/quota";
import { getJob, saveJob, type TranscribeJob } from "@/lib/jobs";
import { checkRateLimit } from "@/lib/rateLimit";
import { getClientIp } from "@/lib/ip";
import { isSameOrigin } from "@/lib/origin";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Origen no permitido." }, { status: 403 });
  }

  const ip = getClientIp(req);
  const rateLimit = await checkRateLimit("step", ip);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Demasiadas consultas seguidas. Esperá un momento." }, { status: 429 });
  }

  let body: { jobId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido." }, { status: 400 });
  }

  if (!body.jobId || typeof body.jobId !== "string") {
    return NextResponse.json({ error: "Falta el jobId." }, { status: 400 });
  }

  let job: TranscribeJob | null = null;
  try {
    job = await getJob(body.jobId);
    if (!job) {
      return NextResponse.json(
        { error: "Esta transcripción expiró o no existe. Empezá de nuevo." },
        { status: 404 }
      );
    }

    const totalChunks = job.chunks.length;

    if (job.status === "done") {
      return NextResponse.json({
        status: "done",
        videoId: job.videoId,
        lang: job.lang,
        title: job.title,
        rawText: job.rawText,
        coherentText: job.editedChunks.join("\n\n"),
        totalChunks,
      });
    }

    if (job.status === "error") {
      return NextResponse.json({ status: "error", error: job.errorMessage || "Error desconocido." });
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
      return NextResponse.json({
        status: "waiting",
        currentIndex: job.currentIndex,
        totalChunks,
        retryInMs: quota.retryInMs,
      });
    }

    const result = await processChunk(job.chunks[job.currentIndex], buildSystemPrompt(job.title), apiKey);

    if (result.status === "rate_limited") {
      const refreshed = await hasQuotaRemaining();
      return NextResponse.json({
        status: "waiting",
        currentIndex: job.currentIndex,
        totalChunks,
        retryInMs: refreshed.retryInMs || 15000,
      });
    }

    job.editedChunks.push(result.text);
    job.currentIndex += 1;

    if (job.currentIndex >= totalChunks) {
      job.status = "done";
      await saveJob(job);
      return NextResponse.json({
        status: "done",
        videoId: job.videoId,
        lang: job.lang,
        title: job.title,
        rawText: job.rawText,
        coherentText: job.editedChunks.join("\n\n"),
        totalChunks,
      });
    }

    await saveJob(job);
    return NextResponse.json({ status: "progress", currentIndex: job.currentIndex, totalChunks });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido.";
    if (job) {
      job.status = "error";
      job.errorMessage = message;
      await saveJob(job).catch(() => {});
    }
    return NextResponse.json({ status: "error", error: message });
  }
}
