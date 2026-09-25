import { Ratelimit, type Duration } from "@upstash/ratelimit";
import { getRedis } from "./redis";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
  /** Which rule tripped, for a clearer message to the user. */
  reason?: "burst" | "capped";
}

interface LimitConfig {
  burstLimit: number;
  burstWindow: Duration;
  cappedLimit: number;
  cappedWindow: Duration;
}

// Named buckets per IP:
// - "transcribe" protects the shared Groq quota — consumed once per video
//   (on job start), not per chunk, since a long video can need many steps.
// - "lookup" just keeps a bot from hammering YouTube's endpoint via
//   /api/languages; it doesn't touch Groq so it can be more generous.
// - "step" guards /api/transcribe/step, which the client polls repeatedly
//   while a job runs. It doesn't call Groq unless our own quota check says
//   there's room (so it can't be used to burn the shared quota faster),
//   but still needs a ceiling against a client hammering it pointlessly.
// Each has a short burst guard (kills fast scripted hammering) and a
// longer capped window. All are backed by Upstash so the count is real
// across every serverless instance, not just the one that handled the
// request.
const CONFIGS: Record<string, LimitConfig> = {
  transcribe: { burstLimit: 1, burstWindow: "20 s", cappedLimit: 5, cappedWindow: "1 h" },
  lookup: { burstLimit: 1, burstWindow: "5 s", cappedLimit: 20, cappedWindow: "1 h" },
  step: { burstLimit: 3, burstWindow: "2 s", cappedLimit: 600, cappedWindow: "1 h" },
};

type LimiterName = keyof typeof CONFIGS;

const limiterCache = new Map<LimiterName, { burst: Ratelimit; capped: Ratelimit } | null>();

function getLimiters(name: LimiterName): { burst: Ratelimit; capped: Ratelimit } | null {
  if (limiterCache.has(name)) return limiterCache.get(name)!;

  const redis = getRedis();
  if (!redis) {
    limiterCache.set(name, null);
    return null;
  }

  const config = CONFIGS[name];
  const limiters = {
    burst: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(config.burstLimit, config.burstWindow),
      prefix: `rl:${name}:burst`,
    }),
    capped: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(config.cappedLimit, config.cappedWindow),
      prefix: `rl:${name}:capped`,
    }),
  };
  limiterCache.set(name, limiters);
  return limiters;
}

/**
 * In-memory fallback for local dev when Upstash isn't configured yet.
 * NOT reliable in serverless production — each instance has its own copy.
 */
const memoryHits = new Map<string, number[]>();

function checkInMemory(name: LimiterName, key: string): RateLimitResult {
  const { cappedLimit } = CONFIGS[name];
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const windowStart = now - windowMs;
  const mapKey = `${name}:${key}`;

  const timestamps = (memoryHits.get(mapKey) || []).filter((t) => t > windowStart);

  if (timestamps.length >= cappedLimit) {
    const resetInMs = timestamps[0] + windowMs - now;
    memoryHits.set(mapKey, timestamps);
    return { allowed: false, remaining: 0, resetInMs, reason: "capped" };
  }

  timestamps.push(now);
  memoryHits.set(mapKey, timestamps);
  return { allowed: true, remaining: cappedLimit - timestamps.length, resetInMs: windowMs };
}

export interface IpQuota {
  remaining: number;
  limit: number;
}

/** Non-consuming read of how many requests this IP has left in a bucket. */
export async function getIpRemaining(name: LimiterName, key: string): Promise<IpQuota> {
  const { cappedLimit } = CONFIGS[name];
  const limiters = getLimiters(name);
  if (!limiters) {
    const timestamps = (memoryHits.get(`${name}:${key}`) || []).filter(
      (t) => t > Date.now() - 60 * 60 * 1000
    );
    return { remaining: Math.max(0, cappedLimit - timestamps.length), limit: cappedLimit };
  }

  try {
    const { remaining } = await limiters.capped.getRemaining(key);
    return { remaining, limit: cappedLimit };
  } catch (err) {
    console.error(`[rateLimit] getIpRemaining("${name}") failed, reporting full quota:`, err);
    return { remaining: cappedLimit, limit: cappedLimit };
  }
}

/**
 * A misconfigured or momentarily unreachable Upstash instance should never
 * take the whole site down — rate limiting is a protection, not core
 * functionality. If the Redis-backed check itself fails, fail open (allow
 * the request) and log server-side so it's still visible in Vercel's logs.
 */
export async function checkRateLimit(name: LimiterName, key: string): Promise<RateLimitResult> {
  const limiters = getLimiters(name);
  if (!limiters) {
    return checkInMemory(name, key);
  }

  try {
    const burst = await limiters.burst.limit(key);
    if (!burst.success) {
      return {
        allowed: false,
        remaining: 0,
        resetInMs: Math.max(0, burst.reset - Date.now()),
        reason: "burst",
      };
    }

    const capped = await limiters.capped.limit(key);
    if (!capped.success) {
      return {
        allowed: false,
        remaining: 0,
        resetInMs: Math.max(0, capped.reset - Date.now()),
        reason: "capped",
      };
    }

    return {
      allowed: true,
      remaining: capped.remaining,
      resetInMs: Math.max(0, capped.reset - Date.now()),
    };
  } catch (err) {
    console.error(`[rateLimit] checkRateLimit("${name}") failed, failing open:`, err);
    return { allowed: true, remaining: 0, resetInMs: 0 };
  }
}
