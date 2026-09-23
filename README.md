# Transcriptor de YouTube

Transcriptor web gratuito de videos de YouTube: baja los subtítulos automáticos del video y les aplica coherencia (puntuación, párrafos, corrección de errores obvios) usando un modelo de IA a través de [Groq](https://groq.com) (capa gratuita).

## Cómo funciona

1. El usuario pega la URL de un video de YouTube.
2. `src/lib/youtube.ts` extrae el ID del video, lista los idiomas de subtítulos disponibles y el título del video (usando el endpoint interno de YouTube, sin API key oficial), y el usuario elige el idioma.
3. `src/lib/coherence.ts` parte la transcripción en fragmentos y se los manda a un modelo de Groq (por defecto `openai/gpt-oss-120b`) para agregar puntuación y coherencia, usando el título del video como contexto para desambiguar nombres propios y jerga — sin resumir ni inventar contenido. El catálogo de modelos de Groq cambia con el tiempo — si da error `model_not_found`, revisá los modelos vigentes en [console.groq.com/docs/models](https://console.groq.com/docs/models) y ajustá `GROQ_MODEL`.
4. `src/lib/rateLimit.ts` y `src/lib/quota.ts` protegen la cuota compartida de Groq (ver "Cupos y rate limit" abajo).

## Setup local

Este proyecto usa [pnpm](https://pnpm.io) como package manager (en vez de npm) porque desde la v10 bloquea por defecto los scripts `postinstall` de las dependencias — una mitigación real contra ataques de cadena de suministro (npm los ejecuta todos por defecto). Si instalás una dependencia nueva que necesite correr un script de build, pnpm te va a avisar y hay que aprobarlo a mano editando `pnpm-workspace.yaml` (clave `allowBuilds`) o corriendo `pnpm approve-builds`.

```bash
pnpm install
cp .env.example .env.local
```

Conseguí una API key gratis en [console.groq.com/keys](https://console.groq.com/keys) y pegala en `.env.local`:

```
GROQ_API_KEY=tu_key_aca
```

Después:

```bash
pnpm dev
```

Abrí [http://localhost:3000](http://localhost:3000).

## Cupos y rate limit

El sitio está pensado para uso personal o de un grupo chico, no para tráfico masivo — todos los usuarios comparten la misma cuota gratuita de Groq. Para protegerla:

- **Rate limit por IP**, en dos capas: máximo 1 request cada 20s (frena ráfagas de script/bot) y máximo 5 transcripciones por hora.
- **Cupo global visible**: la página lee los headers reales que devuelve Groq en cada respuesta (`x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`) y los muestra como "Cupo compartido: X/Y transcripciones". Si se agota, el botón de transcribir se deshabilita con un mensaje claro en vez de fallar con un error.
- Un chequeo de `Origin`/`Referer` descarta pegadas directas al API desde otro sitio (no frena a un bot decidido que falsifique headers, pero corta el abuso casual).

Todo esto necesita un contador **compartido entre todas las instancias del servidor**, así que corre sobre [Upstash Redis](https://upstash.com) (capa gratuita, sin tarjeta). Sin esas variables configuradas, la app sigue funcionando pero cae a un rate limit en memoria por instancia — débil en producción serverless, suficiente solo para desarrollo local.

Para configurarlo:

1. Creá una cuenta gratis en [console.upstash.com](https://console.upstash.com).
2. `Redis` → `Create Database` (cualquier región cercana sirve).
3. En la pestaña `REST API` de la base, copiá `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN` a tu `.env.local` (y a las variables de entorno de Vercel en producción).

## Deploy

Pensado para desplegar gratis en [Vercel](https://vercel.com):

1. Subí el repo a GitHub.
2. Importalo en Vercel.
3. En las variables de entorno del proyecto, agregá `GROQ_API_KEY`, `UPSTASH_REDIS_REST_URL` y `UPSTASH_REDIS_REST_TOKEN` (y opcionalmente `GROQ_MODEL`).

## Limitaciones conocidas

- El cupo global mostrado en la página es el de Groq para todo el sitio, no por usuario — si hay tráfico simultáneo alto, se puede agotar rápido igual (ver "Cupos y rate limit").
- El chequeo de `Origin`/`Referer` y el rate limit por IP son defensa en profundidad contra abuso casual y bots simples; no son una barrera contra un atacante decidido con IPs rotativas.
- Depende de que el video tenga subtítulos (automáticos o manuales) habilitados en YouTube.
- La librería `youtube-transcript` y las consultas de idiomas/título usan un endpoint no oficial de YouTube; si YouTube cambia su estructura interna, puede requerir actualizarla. Con tráfico sostenido existe cierto riesgo de que YouTube limite la IP del servidor — para escalar en serio conviene migrar a la API oficial de YouTube (paga por cuota).
