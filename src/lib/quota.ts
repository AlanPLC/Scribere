import { getRedis } from "./redis";

const REDIS_KEY = "quota:groq";
const MIN_TOKENS_FOR_A_REQUEST = 500;
// Upper bound on how long a cached "quota exhausted" reading is trusted
// for, regardless of what Groq's reset headers say. Without this, once
// remainingTokens hits ~0 we'd stop calling Groq entirely (that's the
// whole point of the pre-flight check) — but that also means we'd never
// get fresh headers again, so the cached snapshot would stay stuck at
// "exhausted" forever even after Groq's real window resets. Expiring the
// cache forces an optimistic retry, which either confirms we're still
// capped (and refreshes with real numbers) or discovers we've recovered.
const MAX_CACHE_TTL_SECONDS = 120;

export interface GroqQuotaSnapshot {
  limitRequests: number;
  remainingRequests: number;
  resetRequestsMs: number;
  limitTokens: number;
  remainingTokens: number;
  resetTokensMs: number;
  updatedAt: number;
}

/** In-memory fallback when Upstash isn't configured (local dev). */
let memorySnapshot: { snapshot: GroqQuotaSnapshot; expiresAt: number } | null = null;

/**
 * Parses Groq's Go-style duration strings from its rate-limit headers,
 * e.g. "11m31.2s", "53.97s", "1h2m3s".
 */
function parseGroqDuration(value: string | null): number {
  if (!value) return 0;
  const regex = /(\d+(?:\.\d+)?)(h|m|s|ms)/g;
  let totalMs = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    const amount = parseFloat(match[1]);
    switch (match[2]) {
      case "h":
        totalMs += amount * 3_600_000;
        break;
      case "m":
        totalMs += amount * 60_000;
        break;
      case "s":
        totalMs += amount * 1000;
        break;
      case "ms":
        totalMs += amount;
        break;
    }
  }
  return totalMs;
}

/**
 * Reads Groq's rate-limit headers off a response and caches them as the
 * latest known snapshot of our shared quota. Called after every real
 * Groq request, so the cached number stays a live reflection of the
 * account's actual state instead of a separately-maintained guess.
 */
export async function updateQuotaFromHeaders(headers: Headers): Promise<void> {
  const limitRequests = Number(headers.get("x-ratelimit-limit-requests"));
  const remainingRequests = Number(headers.get("x-ratelimit-remaining-requests"));
  const limitTokens = Number(headers.get("x-ratelimit-limit-tokens"));
  const remainingTokens = Number(headers.get("x-ratelimit-remaining-tokens"));

  if (!Number.isFinite(limitRequests) || !Number.isFinite(limitTokens)) {
    return; // headers missing/unexpected shape — leave the cached snapshot as-is
  }

  const resetRequestsMs = parseGroqDuration(headers.get("x-ratelimit-reset-requests"));
  const resetTokensMs = parseGroqDuration(headers.get("x-ratelimit-reset-tokens"));

  const snapshot: GroqQuotaSnapshot = {
    limitRequests,
    remainingRequests,
    resetRequestsMs,
    limitTokens,
    remainingTokens,
    resetTokensMs,
    updatedAt: Date.now(),
  };

  const ttlSeconds = Math.min(
    MAX_CACHE_TTL_SECONDS,
    Math.max(10, Math.ceil(Math.max(resetRequestsMs, resetTokensMs) / 1000) + 5)
  );

  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(REDIS_KEY, snapshot, { ex: ttlSeconds });
    } catch (err) {
      console.error("[quota] failed to cache quota snapshot in Redis:", err);
    }
  } else {
    memorySnapshot = { snapshot, expiresAt: Date.now() + ttlSeconds * 1000 };
  }
}

export async function getQuotaSnapshot(): Promise<GroqQuotaSnapshot | null> {
  const redis = getRedis();
  if (redis) {
    try {
      return (await redis.get<GroqQuotaSnapshot>(REDIS_KEY)) ?? null;
    } catch (err) {
      console.error("[quota] failed to read quota snapshot from Redis:", err);
      return null;
    }
  }
  if (memorySnapshot && memorySnapshot.expiresAt > Date.now()) {
    return memorySnapshot.snapshot;
  }
  return null;
}

/** How much of a reset window is left, accounting for time already elapsed since the snapshot was taken. */
function msRemaining(snapshot: GroqQuotaSnapshot, resetMs: number): number {
  const elapsed = Date.now() - snapshot.updatedAt;
  return Math.max(1000, resetMs - elapsed);
}

/**
 * Cheap pre-flight check so we can refuse with a friendly message instead
 * of burning a request against Groq just to get a 429 back. Errs on the
 * side of allowing the request when we don't have a snapshot yet (e.g.
 * right after a cold start, or once the cached snapshot has expired) —
 * that request's real response is what refreshes the cache.
 *
 * When not ok, `retryInMs` estimates how long until the specific limit
 * that's blocking us (requests or tokens) should have room again.
 */
export async function hasQuotaRemaining(): Promise<{
  ok: boolean;
  snapshot: GroqQuotaSnapshot | null;
  retryInMs: number;
}> {
  const snapshot = await getQuotaSnapshot();
  if (!snapshot) return { ok: true, snapshot: null, retryInMs: 0 };

  const requestsOut = snapshot.remainingRequests <= 0;
  const tokensOut = snapshot.remainingTokens < MIN_TOKENS_FOR_A_REQUEST;
  const ok = !requestsOut && !tokensOut;

  const retryInMs = ok
    ? 0
    : requestsOut
      ? msRemaining(snapshot, snapshot.resetRequestsMs)
      : msRemaining(snapshot, snapshot.resetTokensMs);

  return { ok, snapshot, retryInMs };
}
