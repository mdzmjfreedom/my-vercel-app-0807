import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { after } from "next/server";
import { jsonError } from "@/lib/api-helpers";
import { dispatchOutbox, processImportEvent } from "@/lib/import-service";

export const runtime = "nodejs";
export const maxDuration = 60;

async function handler(req: Request) {
  try {
    const body = await req.json() as { outboxId?: unknown };
    if (typeof body.outboxId !== "string" || !body.outboxId.startsWith("evt_")) {
      return jsonError("Invalid QStash import event", 400);
    }
    await processImportEvent(body.outboxId);
    after(() => dispatchOutbox(100));
    return Response.json({ processed: true, outbox_id: body.outboxId });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Import worker failed", 500);
  }
}

export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "production" && !process.env.QSTASH_CURRENT_SIGNING_KEY) {
    return handler(req);
  }
  return verifySignatureAppRouter(handler)(req);
}
