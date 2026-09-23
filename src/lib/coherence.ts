import Groq, { RateLimitError } from "groq-sdk";
import { updateQuotaFromHeaders } from "./quota";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const CHUNK_CHARS = 6000;

export class QuotaExceededError extends Error {}

function buildSystemPrompt(videoTitle?: string): string {
  const titleContext = videoTitle
    ? `\n\nEl video se titula: "${videoTitle}". Usá ese título solo como contexto para desambiguar nombres propios, jerga o términos del tema — no lo repitas ni lo menciones en tu respuesta.`
    : "";

  return `Sos un editor de transcripciones. Recibís fragmentos de la transcripción automática de un video de YouTube: texto plano, sin puntuación confiable, sin párrafos y a veces con errores de reconocimiento de voz.

Tu tarea:
- Agregar puntuación, mayúsculas y párrafos para que el texto se lea con coherencia y fluidez.
- Corregir errores obvios de transcripción automática cuando el contexto lo deje claro.
- NO resumir, NO omitir información, NO agregar contenido que no esté en el original.
- Mantené el mismo idioma del texto original.
- Devolvé únicamente el texto editado, sin comentarios, títulos ni notas adicionales.${titleContext}`;
}

function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const words = text.split(" ");
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    if ((current + " " + word).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

export interface CoherenceResult {
  text: string;
  chunkCount: number;
}

export async function addCoherence(
  rawText: string,
  apiKey: string,
  videoTitle?: string
): Promise<CoherenceResult> {
  const client = new Groq({ apiKey });
  const chunks = splitIntoChunks(rawText, CHUNK_CHARS);
  const systemPrompt = buildSystemPrompt(videoTitle);

  const edited: string[] = [];
  for (const chunk of chunks) {
    let data, response;
    try {
      ({ data, response } = await client.chat.completions
        .create({
          model: MODEL,
          temperature: 0.2,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: chunk },
          ],
        })
        .withResponse());
    } catch (err) {
      if (err instanceof RateLimitError) {
        await updateQuotaFromHeaders(err.headers);
        throw new QuotaExceededError(
          "Se agotó la cuota compartida de IA justo mientras procesábamos este video. Probá de nuevo en unos minutos."
        );
      }
      throw err;
    }

    await updateQuotaFromHeaders(response.headers);

    const content = data.choices[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("La IA no devolvió contenido para uno de los fragmentos.");
    }
    edited.push(content);
  }

  return { text: edited.join("\n\n"), chunkCount: chunks.length };
}
