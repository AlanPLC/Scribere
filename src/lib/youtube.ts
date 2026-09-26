import { YoutubeTranscript } from "youtube-transcript";

export class TranscriptError extends Error {}

// Above this, a video's transcript needs so many AI chunks that it risks
// hogging the shared Groq quota for a long stretch (or timing out). Keeps
// the site usable for everyone instead of one huge video blocking it.
export const MAX_VIDEO_SECONDS = 60 * 60;

/**
 * Accepts a full YouTube URL or a bare video ID and returns the video ID.
 */
export function extractVideoId(input: string): string {
  const trimmed = input.trim();

  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.slice(1);
      if (id) return id;
    }
    if (url.hostname.endsWith("youtube.com")) {
      const v = url.searchParams.get("v");
      if (v) return v;
      const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) return shortsMatch[1];
      const embedMatch = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch) return embedMatch[1];
    }
  } catch {
    // not a valid URL, fall through
  }

  throw new TranscriptError("No se pudo reconocer un ID de video de YouTube en esa URL.");
}

// Same InnerTube endpoint / Android client context the youtube-transcript
// library uses internally to read caption tracks — replicated here because
// the library only exposes "fetch the transcript", not "list the tracks".
const INNERTUBE_API_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const INNERTUBE_CLIENT_VERSION = "20.10.38";
const INNERTUBE_USER_AGENT = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;

// Cloud/datacenter IPs (Vercel, AWS, etc.) get rate-limited or silently
// stonewalled by the ANDROID InnerTube client far more than home IPs do —
// it can come back with zero caption tracks even for a video that clearly
// has them. Falling back to scraping the public watch page (same trick
// the youtube-transcript library uses for its own fallback) recovers most
// of the time, since it's indistinguishable from a normal browser visit.
const WATCH_PAGE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface RawCaptionTrack {
  languageCode: string;
  kind?: string;
  name?: { simpleText?: string };
}

export interface CaptionLanguage {
  code: string;
  isGenerated: boolean;
}

interface PlayerData {
  captionTracks: RawCaptionTrack[];
  title: string;
  durationSeconds: number;
}

function extractPlayerData(data: {
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: RawCaptionTrack[] } };
  videoDetails?: { title?: string; lengthSeconds?: string | number };
}): PlayerData {
  return {
    captionTracks: data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [],
    title: data?.videoDetails?.title ?? "",
    durationSeconds: Number(data?.videoDetails?.lengthSeconds) || 0,
  };
}

async function fetchPlayerDataViaInnerTube(videoId: string): Promise<PlayerData | null> {
  try {
    const resp = await fetch(INNERTUBE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": INNERTUBE_USER_AGENT,
      },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: INNERTUBE_CLIENT_VERSION } },
        videoId,
      }),
    });
    if (!resp.ok) return null;
    return extractPlayerData(await resp.json());
  } catch {
    return null;
  }
}

/** Pulls the inline `var ytInitialPlayerResponse = {...};` JSON blob out of the watch page HTML. */
function parseInitialPlayerResponse(html: string): Record<string, unknown> | null {
  const startToken = "var ytInitialPlayerResponse = ";
  const startIndex = html.indexOf(startToken);
  if (startIndex === -1) return null;

  const jsonStart = startIndex + startToken.length;
  let depth = 0;
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(jsonStart, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchPlayerDataFromWatchPage(videoId: string): Promise<PlayerData | null> {
  try {
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent": WATCH_PAGE_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!resp.ok) return null;

    const html = await resp.text();
    const data = parseInitialPlayerResponse(html);
    if (!data) return null;

    return extractPlayerData(data as Parameters<typeof extractPlayerData>[0]);
  } catch {
    return null;
  }
}

async function fetchPlayerData(videoId: string): Promise<PlayerData> {
  const viaInnerTube = await fetchPlayerDataViaInnerTube(videoId);
  if (viaInnerTube && viaInnerTube.captionTracks.length > 0) {
    return viaInnerTube;
  }

  const viaWatchPage = await fetchPlayerDataFromWatchPage(videoId);
  if (viaWatchPage) {
    return viaWatchPage;
  }

  if (viaInnerTube) return viaInnerTube;
  throw new TranscriptError("No se pudo consultar la información de este video.");
}

/**
 * Lists the caption tracks available for a video (without downloading them)
 * and returns the video's title, used later as context for the AI step.
 */
export async function listAvailableLanguages(input: string): Promise<{
  videoId: string;
  title: string;
  durationSeconds: number;
  languages: CaptionLanguage[];
}> {
  const videoId = extractVideoId(input);
  const { captionTracks, title, durationSeconds } = await fetchPlayerData(videoId);

  if (durationSeconds > MAX_VIDEO_SECONDS) {
    const maxMinutes = Math.round(MAX_VIDEO_SECONDS / 60);
    throw new TranscriptError(
      `Este video dura más de ${maxMinutes} minutos. Por ahora, para no agotar la cuota compartida de IA, el límite es de ${maxMinutes} minutos por video.`
    );
  }

  if (!captionTracks.length) {
    throw new TranscriptError("Este video no tiene subtítulos disponibles.");
  }

  // A video can have both a manual and an auto-generated track for the
  // same language code. The underlying fetch can only select by language
  // code (not by manual-vs-generated), so the two would be ambiguous to
  // pick between anyway — keep the manual one since it's higher quality.
  const byCode = new Map<string, boolean>();
  for (const t of captionTracks) {
    const isGenerated = t.kind === "asr";
    if (!byCode.has(t.languageCode) || byCode.get(t.languageCode) === true) {
      byCode.set(t.languageCode, isGenerated);
    }
  }

  return {
    videoId,
    title,
    durationSeconds,
    languages: Array.from(byCode, ([code, isGenerated]) => ({ code, isGenerated })),
  };
}

/**
 * Fetches just the video's title, used as context for the AI coherence step.
 * Fetched server-side (rather than trusted from the client) so the title
 * embedded in the LLM prompt always matches the actual video.
 */
export async function getVideoTitle(input: string): Promise<string> {
  const videoId = extractVideoId(input);
  const { title } = await fetchPlayerData(videoId);
  return title;
}

export interface RawTranscript {
  videoId: string;
  text: string;
  segmentCount: number;
  lang: string;
}

/**
 * Fetches the captions for a video in a specific language (or the track
 * YouTube returns first, if no language is given) and joins them into a
 * single block of raw, unpunctuated-ish text.
 */
export async function fetchRawTranscript(input: string, lang?: string): Promise<RawTranscript> {
  const videoId = extractVideoId(input);

  let segments;
  try {
    segments = await YoutubeTranscript.fetchTranscript(videoId, lang ? { lang } : undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TranscriptError(
      `No se pudo obtener la transcripción de este video. Puede que no tenga subtítulos disponibles. (${message})`
    );
  }

  if (!segments.length) {
    throw new TranscriptError("Este video no tiene subtítulos disponibles.");
  }

  const text = segments
    .map((s) => decodeHtmlEntities(s.text).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");

  return { videoId, text, segmentCount: segments.length, lang: segments[0].lang ?? lang ?? "" };
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
