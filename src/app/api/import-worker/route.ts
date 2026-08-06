import { jsonError } from "@/lib/api-helpers";
import { dispatchOutbox } from "@/lib/import-service";

export const runtime = "nodejs";

export async function POST(req: Request) {
  return runDispatcher(req);
}

export async function GET(req: Request) {
  return runDispatcher(req);
}

async function runDispatcher(req: Request) {
  const expected = process.env.IMPORT_WORKER_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const authorized = (!expected && !cronSecret)
    || Boolean(expected && (req.headers.get("x-import-worker-secret") === expected || bearer === expected))
    || Boolean(cronSecret && bearer === cronSecret);
  if (!authorized) return jsonError("未授权的 Worker 请求", 401);
  try {
    return Response.json({ dispatched: await dispatchOutbox(Number(new URL(req.url).searchParams.get("limit") || 4)) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Worker 执行失败");
  }
}
