import { Worker } from "bullmq";
import IORedis from "ioredis";
import { processImportBatch } from "../src/lib/import-service";

if (!process.env.REDIS_URL) throw new Error("worker:start 需要 REDIS_URL");
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
const concurrency = Number(process.env.IMPORT_WORKER_CONCURRENCY || 4);
const worker = new Worker<{ outboxId: string }>("v4-import-batches", async (job) => processImportBatch(job.data.outboxId), { connection, concurrency });
worker.on("completed", (job) => console.log(JSON.stringify({ event: "job_completed", jobId: job.id })));
worker.on("failed", (job, error) => console.error(JSON.stringify({ event: "job_failed", jobId: job?.id, error: error.message })));
console.log(JSON.stringify({ event: "worker_started", concurrency }));

async function shutdown() { await worker.close(); await connection.quit(); }
process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
