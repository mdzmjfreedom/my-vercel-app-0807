import { jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(_req: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await context.params;
    const batches = await prisma.importTaskBatch.findMany({ where: { taskId }, orderBy: { batchIndex: "asc" }, include: { performance: { orderBy: { createdAt: "desc" }, take: 1 } } });
    return Response.json({ task_id: taskId, batches });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "读取批次性能失败");
  }
}
