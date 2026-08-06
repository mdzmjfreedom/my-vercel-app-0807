import { after } from "next/server";
import { jsonError } from "@/lib/api-helpers";
import { dispatchOutbox } from "@/lib/import-service";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(_req: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await context.params;
    const task = await prisma.importTask.findUnique({ where: { id: taskId }, include: { batches: { orderBy: { batchIndex: "asc" }, select: { id: true, unitId: true, batchIndex: true, startRow: true, endRow: true, status: true, retryCount: true, lastError: true } }, errors: { orderBy: { createdAt: "desc" }, take: 5, select: { rowNumber: true, fieldName: true, rawValue: true, errorCode: true, errorReason: true, batchIndex: true } } } });
    if (!task) return jsonError("任务不存在", 404);
    after(() => dispatchOutbox(20));
    const elapsedMs = (task.completedAt ?? new Date()).getTime() - task.createdAt.getTime();
    const throughput = elapsedMs > 0 ? Math.round((task.successRows / elapsedMs) * 1000 * 60) : 0;
    return Response.json({ task_id: task.id, file_name: task.fileName, trace_id: task.traceId, status: task.status, total_rows: task.totalRows, processed_rows: task.processedRows, success_rows: task.successRows, failed_rows: task.failedRows, total_batches: task.totalBatches, completed_batches: task.completedBatches, degraded: task.degraded, throughput_per_minute: throughput, elapsed_ms: elapsedMs, estimated_remaining_ms: task.status === "PROCESSING" && throughput > 0 ? Math.max(0, Math.round(((task.totalRows - task.processedRows) / throughput) * 60000)) : null, batches: task.batches, recent_errors: task.errors });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "读取任务失败");
  }
}
