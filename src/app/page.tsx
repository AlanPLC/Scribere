"use client";

import { useEffect, useState } from "react";
import { StatsPanel, isQuotaExhausted, type QuotaState } from "@/components/StatsPanel";
import { LimitationsNotice } from "@/components/LimitationsNotice";

interface CaptionLanguage {
  code: string;
  isGenerated: boolean;
}

interface TranscribeResult {
  videoId: string;
  lang: string;
  rawText: string;
  coherentText: string;
}

interface Progress {
  currentIndex: number;
  totalChunks: number;
  waiting: boolean;
  retryInMs?: number;
}

type Tab = "coherent" | "raw";
type Step = "url" | "language" | "result";

function formatWait(ms?: number): string {
  const seconds = Math.max(1, Math.round((ms ?? 5000) / 1000));
  if (seconds < 60) return `~${seconds}s`;
  return `~${Math.round(seconds / 60)} min`;
}

const languageDisplayNames = (() => {
  try {
    return new Intl.DisplayNames(["es"], { type: "language" });
  } catch {
    return null;
  }
})();

function languageLabel(lang: CaptionLanguage): string {
  const name = languageDisplayNames?.of(lang.code) ?? lang.code;
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
  return lang.isGenerated ? `${capitalized} (generado automáticamente)` : capitalized;
}

function pickDefaultLanguage(languages: CaptionLanguage[]): string {
  const browserLang = typeof navigator !== "undefined" ? navigator.language.slice(0, 2) : "es";
  const exact = languages.find((l) => l.code === browserLang);
  if (exact) return exact.code;
  const prefixMatch = languages.find((l) => l.code.startsWith(browserLang));
  if (prefixMatch) return prefixMatch.code;
  return languages[0].code;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [sidebarUrl, setSidebarUrl] = useState("");
  const [step, setStep] = useState<Step>("url");
  const [videoTitle, setVideoTitle] = useState("");
  const [languages, setLanguages] = useState<CaptionLanguage[]>([]);
  const [selectedLang, setSelectedLang] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranscribeResult | null>(null);
  const [tab, setTab] = useState<Tab>("coherent");
  const [copied, setCopied] = useState(false);
  const [quota, setQuota] = useState<QuotaState | null>(null);

  async function refreshQuota() {
    try {
      const res = await fetch("/api/quota");
      if (!res.ok) return;
      setQuota(await res.json());
    } catch {
      // best-effort — the stats panel just won't show if this fails
    }
  }

  useEffect(() => {
    let ignore = false;

    fetch("/api/quota")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!ignore && data) setQuota(data);
      })
      .catch(() => {});

    return () => {
      ignore = true;
    };
  }, []);

  async function findLanguages(targetUrl: string) {
    if (!targetUrl.trim() || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/languages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Ocurrió un error.");
        return;
      }

      setUrl(targetUrl);
      setLanguages(data.languages);
      setVideoTitle(data.title || "");
      setSelectedLang(pickDefaultLanguage(data.languages));
      setStep("language");
    } catch {
      setError("No se pudo conectar con el servidor.");
    } finally {
      setLoading(false);
    }
  }

  function handleFindLanguages(e: React.FormEvent) {
    e.preventDefault();
    findLanguages(url);
  }

  function handleQuickTranscribe(e: React.FormEvent) {
    e.preventDefault();
    findLanguages(sidebarUrl);
    setSidebarUrl("");
  }

  async function pollJob(jobId: string) {
    while (true) {
      let data: {
        status?: "progress" | "waiting" | "done" | "error";
        error?: string;
        currentIndex?: number;
        totalChunks?: number;
        retryInMs?: number;
        videoId?: string;
        lang?: string;
        rawText?: string;
        coherentText?: string;
      };

      try {
        const res = await fetch("/api/transcribe/step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        });
        data = await res.json();
        if (!res.ok && data.status !== "error") {
          setError(data.error || "Ocurrió un error.");
          break;
        }
      } catch {
        setError("No se pudo conectar con el servidor.");
        break;
      }

      if (data.status === "error") {
        setError(data.error || "Ocurrió un error.");
        break;
      }

      if (data.status === "done") {
        setResult({
          videoId: data.videoId!,
          lang: data.lang!,
          rawText: data.rawText!,
          coherentText: data.coherentText!,
        });
        setTab("coherent");
        setStep("result");
        break;
      }

      setProgress({
        currentIndex: data.currentIndex ?? 0,
        totalChunks: data.totalChunks ?? 1,
        waiting: data.status === "waiting",
        retryInMs: data.retryInMs,
      });

      const delay =
        data.status === "waiting" ? Math.min(Math.max(data.retryInMs ?? 5000, 3000), 15000) : 300;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    setLoading(false);
    setProgress(null);
    refreshQuota();
  }

  async function handleTranscribe() {
    if (loading) return;

    setLoading(true);
    setError(null);
    setProgress(null);

    try {
      const res = await fetch("/api/transcribe/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, lang: selectedLang }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Ocurrió un error.");
        setLoading(false);
        return;
      }

      setProgress({ currentIndex: 0, totalChunks: data.totalChunks, waiting: false });
      await pollJob(data.jobId);
    } catch {
      setError("No se pudo conectar con el servidor.");
      setLoading(false);
    }
  }

  function handleReset() {
    setStep("url");
    setUrl("");
    setSidebarUrl("");
    setVideoTitle("");
    setLanguages([]);
    setSelectedLang("");
    setResult(null);
    setError(null);
  }

  function handleCopy() {
    if (!result) return;
    const text = tab === "coherent" ? result.coherentText : result.rawText;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function handleDownload() {
    if (!result) return;
    const text = tab === "coherent" ? result.coherentText : result.rawText;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `transcripcion-${result.videoId}-${tab}.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <main className="flex-1 min-h-0 flex flex-col px-4 sm:px-6">
      <header className="shrink-0 pt-10 sm:pt-16 pb-3 max-w-6xl w-full mx-auto">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Transcriptor de YouTube</h1>
        {step === "url" && (
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Pegá el link de un video y obtené su transcripción con coherencia, gratis.
          </p>
        )}
      </header>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4 pb-4 sm:pb-6 max-w-6xl w-full mx-auto">
        <section className="flex-1 min-h-0 flex flex-col gap-3">
          {step === "url" && (
            <form onSubmit={handleFindLanguages} className="flex gap-2">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-4 py-2.5 text-sm outline-none transition-colors focus:border-neutral-900 dark:focus:border-neutral-100 focus:bg-white dark:focus:bg-neutral-950 disabled:opacity-50"
                disabled={loading || isQuotaExhausted(quota)}
              />
              <button
                type="submit"
                disabled={loading || !url.trim() || isQuotaExhausted(quota)}
                className="rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-5 py-2.5 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? "Buscando…" : "Continuar"}
              </button>
            </form>
          )}

          {step === "url" && <LimitationsNotice />}

          {step === "language" && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between text-sm gap-2">
                <span className="font-medium truncate" title={videoTitle || url}>
                  {videoTitle || url}
                </span>
                <button onClick={handleReset} className="text-neutral-500 hover:underline shrink-0">
                  Cambiar video
                </button>
              </div>

              <label className="text-sm font-medium">Elegí el idioma de los subtítulos</label>
              <select
                value={selectedLang}
                onChange={(e) => setSelectedLang(e.target.value)}
                className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-4 py-2.5 text-sm outline-none transition-colors focus:border-neutral-900 dark:focus:border-neutral-100"
                disabled={loading}
              >
                {languages.map((l) => (
                  <option key={l.code} value={l.code} className="bg-white dark:bg-neutral-900">
                    {languageLabel(l)}
                  </option>
                ))}
              </select>

              <button
                onClick={handleTranscribe}
                disabled={loading || !selectedLang || isQuotaExhausted(quota)}
                className="self-start rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-5 py-2.5 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? "Transcribiendo…" : "Transcribir"}
              </button>

              {loading && !progress && (
                <p className="text-sm text-neutral-500 dark:text-neutral-400">Bajando subtítulos…</p>
              )}

              {loading && progress && (
                <div className="flex flex-col gap-1.5">
                  <div className="h-1.5 w-full rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                    <div
                      className="h-full bg-neutral-900 dark:bg-neutral-100 transition-all duration-300"
                      style={{
                        width: `${
                          progress.totalChunks > 0
                            ? Math.round((progress.currentIndex / progress.totalChunks) * 100)
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">
                    {progress.waiting
                      ? `Esperando cupo compartido de IA, sigue en ${formatWait(progress.retryInMs)}${
                          progress.totalChunks > 1
                            ? ` (fragmento ${progress.currentIndex + 1} de ${progress.totalChunks})`
                            : ""
                        }`
                      : progress.totalChunks > 1
                        ? `Aplicando coherencia con IA, fragmento ${progress.currentIndex} de ${progress.totalChunks}…`
                        : "Aplicando coherencia con IA…"}
                  </p>
                </div>
              )}
            </div>
          )}

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          {result && step === "result" && (
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              <div className="flex items-center justify-between text-sm gap-2">
                <span className="font-medium truncate" title={videoTitle || url}>
                  {videoTitle || url}
                </span>
                <button onClick={handleReset} className="text-neutral-500 hover:underline shrink-0">
                  Transcribir otro video
                </button>
              </div>

              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex gap-1 rounded-lg bg-neutral-100 dark:bg-neutral-800 p-1 text-sm">
                  <button
                    onClick={() => setTab("coherent")}
                    className={`px-3 py-1.5 rounded-md ${
                      tab === "coherent"
                        ? "bg-white dark:bg-neutral-700 shadow-sm font-medium"
                        : "text-neutral-500"
                    }`}
                  >
                    Con coherencia
                  </button>
                  <button
                    onClick={() => setTab("raw")}
                    className={`px-3 py-1.5 rounded-md ${
                      tab === "raw" ? "bg-white dark:bg-neutral-700 shadow-sm font-medium" : "text-neutral-500"
                    }`}
                  >
                    Texto crudo
                  </button>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleCopy}
                    className="text-sm px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    {copied ? "¡Copiado!" : "Copiar"}
                  </button>
                  <button
                    onClick={handleDownload}
                    className="text-sm px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    Descargar .txt
                  </button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto scroll-minimal rounded-lg border border-neutral-200 dark:border-neutral-800 p-5 whitespace-pre-wrap text-sm leading-relaxed">
                {tab === "coherent" ? result.coherentText : result.rawText}
              </div>
            </div>
          )}
        </section>

        <aside className="lg:w-72 shrink-0 flex flex-col gap-4">
          <StatsPanel quota={quota} />

          {step === "result" && (
            <form onSubmit={handleQuickTranscribe} className="flex flex-col gap-2">
              <label className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Transcribir otro
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={sidebarUrl}
                  onChange={(e) => setSidebarUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="min-w-0 flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-3 py-2 text-sm outline-none transition-colors focus:border-neutral-900 dark:focus:border-neutral-100 disabled:opacity-50"
                  disabled={loading || isQuotaExhausted(quota)}
                />
                <button
                  type="submit"
                  disabled={loading || !sidebarUrl.trim() || isQuotaExhausted(quota)}
                  className="shrink-0 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-3 py-2 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Ir
                </button>
              </div>
            </form>
          )}

          {step === "result" && <LimitationsNotice />}
        </aside>
      </div>
    </main>
  );
}
