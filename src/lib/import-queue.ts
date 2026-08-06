import { Client } from "@upstash/qstash";

const globalQueue = globalThis as typeof globalThis & { v4QStashClient?: Client };

export function hasExternalQueue(): boolean {
  return Boolean(process.env.QSTASH_TOKEN?.trim());
}

export function queueMode(): "QSTASH" | "DATABASE_FALLBACK" {
  return hasExternalQueue() ? "QSTASH" : "DATABASE_FALLBACK";
}

export async function enqueueImportEvent(outboxId: string): Promise<void> {
  if (!hasExternalQueue()) throw new Error("QSTASH_TOKEN is not configured");

  await getClient().publishJSON({
    url: resolveWorkerUrl(),
    body: { outboxId },
    deduplicationId: outboxId,
    retries: Number(process.env.IMPORT_MAX_RETRIES || 3),
    retryDelay: "2000 * pow(2, retried)",
    timeout: 60,
  });
}

export function resolveWorkerUrl(): string {
  const explicit = process.env.IMPORT_WORKER_URL?.trim();
  if (explicit) return new URL(explicit).toString();

  const host = process.env.VERCEL_URL?.trim() || process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!host) throw new Error("IMPORT_WORKER_URL or VERCEL_URL is required for QStash delivery");

  const baseUrl = host.startsWith("http://") || host.startsWith("https://") ? host : `https://${host}`;
  return new URL("/api/import-worker/job", baseUrl).toString();
}

function getClient(): Client {
  if (!globalQueue.v4QStashClient) {
    globalQueue.v4QStashClient = new Client({
      token: process.env.QSTASH_TOKEN?.trim(),
      baseUrl: process.env.QSTASH_URL?.trim() || undefined,
    });
  }
  return globalQueue.v4QStashClient;
}
