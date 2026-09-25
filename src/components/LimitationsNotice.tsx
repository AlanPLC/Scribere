export function LimitationsNotice() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 text-xs text-neutral-500 dark:text-neutral-400">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Sobre esta app</p>
      <p>
        Es gratuita, de código abierto y de uso libre, la comparto sin fines de lucro. Por eso tiene
        algunas limitaciones:
      </p>
      <ul className="list-disc pl-4 flex flex-col gap-1">
        <li>
          La IA usa una cuota compartida entre todos los que la usan; en momentos de mucho uso puede
          agotarse temporalmente (mirá el panel de &quot;Uso&quot;).
        </li>
        <li>No transcribe videos de más de 1 hora.</li>
        <li>Necesita que el video tenga subtítulos (automáticos o manuales) habilitados en YouTube.</li>
        <li>El texto prolijo lo genera una IA y puede tener errores, revisá el resultado antes de usarlo para algo importante.</li>
      </ul>
    </div>
  );
}
