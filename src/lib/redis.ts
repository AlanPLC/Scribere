import { Redis } from "@upstash/redis";

let client: Redis | null | undefined;

/**
 * Returns a shared Upstash Redis client, or null if it's not configured.
 * Callers should fall back to a best-effort in-memory behavior when this
 * is null (e.g. local dev without an Upstash account set up yet).
 */
export function getRedis(): Redis | null {
  if (client !== undefined) return client;

  // .trim() guards against a trailing newline/space from copy-pasting the
  // value into Vercel's env var UI — a very easy mistake that silently
  // breaks every request to Upstash's REST API.
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  client = url && token ? new Redis({ url, token }) : null;
  return client;
}
