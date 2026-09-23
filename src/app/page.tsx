"use client";

import { useEffect, useState } from "react";
import { QuotaBanner, isQuotaExhausted, type QuotaState } from "@/components/QuotaBanner";

interface CaptionLanguage {
  code: string;
  isGenerated: boolean;
}

interface TranscribeResponse {
  videoId: string;
  lang: string;
  rawText: string;
  coherentText: string;
  remaining: number;
}

type Tab = "coherent" | "raw";
type Step = "url" | "language" | "result";

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
  const [step, setStep] = useState<Step>("url");
  const [languages, setLanguages] = useState<CaptionLanguage[]>([]);
  const [selectedLang, setSelectedLang] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranscribeResponse | null>(null);
  const [tab, setTab] = useState<Tab>("coherent");
  const [copied, setCopied] = useState(false);
  const [quota, setQuota] = useState<QuotaState | null>(null);

  async function refreshQuota() {
    try {
      const res = await fetch("/api/quota");
      if (!res.ok) return;
      setQuota(await res.json());
    } catch {
      // best-effort — the quota banner just won't show if this fails
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

  async function handleFindLanguages(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/languages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Ocurrió un error.");
        return;
      }

      setLanguages(data.languages);
      setSelectedLang(pickDefaultLanguage(data.languages));
      setStep("language");
    } catch {
      setError("No se pudo conectar con el servidor.");
    } finally {
      setLoading(false);
    }
  }

  async function handleTranscribe() {
    if (loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, lang: selectedLang }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Ocurrió un error.");
        return;
      }

      setResult(data);
      setTab("coherent");
      setStep("result");
    } catch {
      setError("No se pudo conectar con el servidor.");
    } finally {
      setLoading(false);
      refreshQuota();
    }
  }

  function handleReset() {
    setStep("url");
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
    <main className="flex-1 flex flex-col items-center px-4 py-12 sm:py-20 gap-10">
      <div className="text-center max-w-xl">
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
          Transcriptor de YouTube
        </h1>
        <p className="mt-3 text-neutral-500 dark:text-neutral-400">
          Pegá el link de un video y obtené su transcripción con coherencia, gratis.
        </p>
      </div>

      <QuotaBanner quota={quota} />

      {step === "url" && (
        <form onSubmit={handleFindLanguages} className="w-full max-w-xl flex gap-2">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-neutral-500 dark:focus:border-neutral-500"
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

      {step === "language" && (
        <div className="w-full max-w-xl flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-neutral-500 dark:text-neutral-400 truncate">{url}</span>
            <button onClick={handleReset} className="text-neutral-500 hover:underline shrink-0 ml-2">
              Cambiar video
            </button>
          </div>

          <label className="text-sm font-medium">Elegí el idioma de los subtítulos</label>
          <select
            value={selectedLang}
            onChange={(e) => setSelectedLang(e.target.value)}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-4 py-2.5 text-sm outline-none focus:border-neutral-500"
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
            className="rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-5 py-2.5 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? "Transcribiendo…" : "Transcribir"}
          </button>
        </div>
      )}

      {error && (
        <p className="w-full max-w-xl text-sm text-red-600 dark:text-red-400 text-center">
          {error}
        </p>
      )}

      {loading && step === "language" && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Bajando subtítulos y aplicando coherencia con IA. Puede tardar un poco en videos largos…
        </p>
      )}

      {result && step === "result" && (
        <div className="w-full max-w-3xl flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-neutral-500 dark:text-neutral-400 truncate">{url}</span>
            <button onClick={handleReset} className="text-neutral-500 hover:underline shrink-0 ml-2">
              Transcribir otro video
            </button>
          </div>

          <div className="flex items-center justify-between">
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
                  tab === "raw"
                    ? "bg-white dark:bg-neutral-700 shadow-sm font-medium"
                    : "text-neutral-500"
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

          <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 p-5 max-h-[60vh] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">
            {tab === "coherent" ? result.coherentText : result.rawText}
          </div>
        </div>
      )}
    </main>
  );
}
