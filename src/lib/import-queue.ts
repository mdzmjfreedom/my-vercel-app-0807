import { Queue } from "bullmq";
import IORedis from "ioredis";

const globalQueue = globalThis as typeof globalThis & { v4ImportQueue?: Queue; v4ImportRedis?: IORedis };

export function hasExternalQueue(): boolean {
  return Boolean(process.env.REDIS_URL);
}

export async function enqueueImportEvent(outboxId: string): Promise<void> {
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL 未配置");
  const queue = getQueue();
  await queue.add("process-import-batch", { outboxId }, {
    jobId: outboxId,
    attempts: Number(process.env.IMPORT_MAX_RETRIES || 3),
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}

function getQueue(): Queue {
  if (!globalQueue.v4ImportRedis) globalQueue.v4ImportRedis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null, enableReadyCheck: false });
  globalQueue.v4ImportQueue ??= new Queue("v4-import-batches", { connection: globalQueue.v4ImportRedis });
  return globalQueue.v4ImportQueue;
}
