import { NextRequest } from "next/server";

/**
 * Best-effort check that a request came from our own frontend rather than
 * a script hitting the API directly from another origin. A determined bot
 * can still spoof these headers — this only filters out casual abuse, it's
 * not a security boundary on its own.
 */
export function isSameOrigin(req: NextRequest): boolean {
  const selfOrigin = req.nextUrl.origin;

  const origin = req.headers.get("origin");
  if (origin) return origin === selfOrigin;

  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === selfOrigin;
    } catch {
      return false;
    }
  }

  // Neither header present: allow. Some legitimate same-origin requests
  // (older browsers, certain proxies) omit both.
  return true;
}
