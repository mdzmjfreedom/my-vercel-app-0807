import { jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(_req: Request, context: { params: Promise<{ traceId: string }> }) {
  try {
    const { traceId } = await context.params;
    const events = await prisma.traceEvent.findMany({ where: { traceId }, orderBy: { occurredAt: "asc" }, include: { batch: { select: { batchIndex: true, startRow: true, endRow: true, status: true, retryCount: true } } } });
    if (!events.length) return jsonError("Trace 不存在", 404);
    return Response.json({ trace_id: traceId, events });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Trace 查询失败");
  }
}
