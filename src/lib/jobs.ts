import { randomUUID } from "node:crypto";
import { getRedis } from "./redis";

export interface TranscribeJob {
  id: string;
  videoId: string;
  lang: string;
  title: string;
  rawText: string;
  chunks: string[];
  /** Edited text for chunks [0, currentIndex). */
  editedChunks: string[];
  currentIndex: number;
  status: "processing" | "done" | "error";
  errorMessage?: string;
  createdAt: number;
}

// Long enough to ride out a Groq per-minute rate limit wait on a long
// video (several minutes of polling, worst case), short enough that an
// abandoned job doesn't linger.
const TTL_SECONDS = 30 * 60;

const memoryJobs = new Map<string, TranscribeJob>();

function redisKey(id: string): string {
  return `job:${id}`;
}

export function newJobId(): string {
  return randomUUID();
}

export async function saveJob(job: TranscribeJob): Promise<void> {
  const redis = getRedis();
  if (redis) {
    await redis.set(redisKey(job.id), job, { ex: TTL_SECONDS });
  } else {
    memoryJobs.set(job.id, job);
  }
}

export async function getJob(id: string): Promise<TranscribeJob | null> {
  const redis = getRedis();
  if (redis) {
    return (await redis.get<TranscribeJob>(redisKey(id))) ?? null;
  }
  return memoryJobs.get(id) ?? null;
}
