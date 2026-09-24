import { NextRequest, NextResponse } from "next/server";
import { getQuotaSnapshot } from "@/lib/quota";
import { getIpRemaining } from "@/lib/rateLimit";
import { getClientIp } from "@/lib/ip";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const [global, ipQuota] = await Promise.all([getQuotaSnapshot(), getIpRemaining("transcribe", ip)]);

  return NextResponse.json({
    global: global
      ? {
          remainingRequests: global.remainingRequests,
          limitRequests: global.limitRequests,
          remainingTokens: global.remainingTokens,
          limitTokens: global.limitTokens,
          resetRequestsMs: global.resetRequestsMs,
          resetTokensMs: global.resetTokensMs,
          updatedAt: global.updatedAt,
        }
      : null,
    ip: ipQuota,
  });
}
