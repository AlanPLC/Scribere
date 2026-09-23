interface QuotaGlobal {
  remainingRequests: number;
  limitRequests: number;
  remainingTokens: number;
  limitTokens: number;
  resetRequestsMs: number;
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

function formatDuration(ms: number): string {
  if (ms <= 0) return "en instantes";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "en menos de un minuto";
  if (minutes < 60) return `en ~${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `en ~${hours} h`;
}

export function QuotaBanner({ quota }: { quota: QuotaState | null }) {
  if (!quota) return null;

  if (isQuotaExhausted(quota)) {
    const ipExhausted = quota.ip.remaining <= 0;
    return (
      <div className="w-full max-w-xl rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
        {ipExhausted
          ? "Ya usaste tus transcripciones disponibles por esta hora. Probá de nuevo más tarde."
          : "Se agotaron las transcripciones gratuitas disponibles por ahora (cupo compartido entre todos los que usan el sitio). Probá de nuevo más tarde."}
      </div>
    );
  }

  const { global, ip } = quota;

  return (
    <div className="w-full max-w-xl flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-neutral-400">
      {global && (
        <span>
          Cupo compartido: {global.remainingRequests}/{global.limitRequests} transcripciones
          {global.remainingRequests < global.limitRequests * 0.2 &&
            ` (se renueva ${formatDuration(global.resetRequestsMs)})`}
        </span>
      )}
      <span>
        Tu límite: {ip.remaining}/{ip.limit} por hora
      </span>
    </div>
  );
}
