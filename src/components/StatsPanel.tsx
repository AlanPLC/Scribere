import { useEffect, useState } from "react";

interface QuotaGlobal {
  remainingRequests: number;
  limitRequests: number;
  remainingTokens: number;
  limitTokens: number;
  resetRequestsMs: number;
  resetTokensMs: number;
  updatedAt: number;
}

interface QuotaIp {
  remaining: number;
  limit: number;
}

export interface QuotaState {
  global: QuotaGlobal | null;
  ip: QuotaIp;
}

const MIN_TOKENS_FOR_A_REQUEST = 500;

export function isQuotaExhausted(quota: QuotaState | null): boolean {
  if (!quota) return false;
  const globalExhausted =
    !!quota.global &&
    (quota.global.remainingRequests <= 0 || quota.global.remainingTokens < MIN_TOKENS_FOR_A_REQUEST);
  const ipExhausted = quota.ip.remaining <= 0;
  return globalExhausted || ipExhausted;
}

/** Re-renders the component periodically so "se renueva en ~Xs" tooltips stay roughly live. */
function useTick(intervalMs: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

function formatDuration(ms: number): string {
  if (ms <= 1000) return "en instantes";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `en ~${totalSeconds}s`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `en ~${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `en ~${hours} h`;
}

/** How much of a reset window is left right now, given when the snapshot was taken. */
function liveRemaining(resetMs: number, updatedAt: number): number {
  return Math.max(0, resetMs - (Date.now() - updatedAt));
}

function RadialStat({
  value,
  max,
  label,
  tooltip,
}: {
  value: number;
  max: number;
  label: string;
  tooltip?: string;
}) {
  const size = 76;
  const strokeWidth = 6;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const offset = circumference * (1 - pct);

  return (
    <div className="flex flex-col items-center gap-2" title={tooltip}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="stroke-neutral-200 dark:stroke-neutral-800"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            className="stroke-neutral-900 dark:stroke-neutral-100 transition-[stroke-dashoffset] duration-500 ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold">
          {Math.round(pct * 100)}%
        </div>
      </div>
      <div className="text-center">
        <p className="text-xs font-medium">{label}</p>
        <p className="text-[11px] text-neutral-400 tabular-nums">
          {value.toLocaleString("es")}/{max.toLocaleString("es")}
        </p>
      </div>
    </div>
  );
}

function SegmentedBar({ remaining, limit, label }: { remaining: number; limit: number; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-neutral-400 tabular-nums">
          {remaining}/{limit}
        </span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: limit }).map((_, i) => (
          <div
            key={i}
            className={`h-2 flex-1 rounded-full ${
              i < remaining ? "bg-neutral-900 dark:bg-neutral-100" : "bg-neutral-200 dark:bg-neutral-800"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

export function StatsPanel({ quota }: { quota: QuotaState | null }) {
  useTick(5000);
  const exhausted = isQuotaExhausted(quota);
  const global = quota?.global ?? null;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-neutral-200 dark:border-neutral-800 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Uso</p>

      {exhausted && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {quota && quota.ip.remaining <= 0
            ? "Ya usaste tus transcripciones disponibles por esta hora."
            : "Se agotó el cupo compartido por ahora. Probá de nuevo más tarde."}
        </div>
      )}

      {global ? (
        <div className="flex justify-around">
          <RadialStat
            value={global.remainingRequests}
            max={global.limitRequests}
            label="Transcripciones"
            tooltip={`Se renueva ${formatDuration(liveRemaining(global.resetRequestsMs, global.updatedAt))}`}
          />
          <RadialStat
            value={global.remainingTokens}
            max={global.limitTokens}
            label="Tokens IA"
            tooltip={`Se renueva ${formatDuration(liveRemaining(global.resetTokensMs, global.updatedAt))}`}
          />
        </div>
      ) : (
        <p className="text-xs text-neutral-400 text-center py-2">
          Todavía sin datos del cupo compartido, se actualiza con el próximo uso.
        </p>
      )}

      {quota && <SegmentedBar remaining={quota.ip.remaining} limit={quota.ip.limit} label="Tu límite (por hora)" />}

      <p className="text-[11px] text-neutral-400 leading-relaxed">
        Todos los que usan el sitio comparten la misma cuota gratuita de IA.
      </p>
    </div>
  );
}
