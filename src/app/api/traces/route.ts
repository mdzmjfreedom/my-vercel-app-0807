import { jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const taskId = url.searchParams.get("task_id") || undefined;
    const traceId = url.searchParams.get("trace_id") || undefined;
    const fileName = url.searchParams.get("file_name") || undefined;
    const batch = url.searchParams.get("batch");
    const rowFrom = url.searchParams.get("row_from");
    const rowTo = url.searchParams.get("row_to");
    const errorCode = url.searchParams.get("error_code") || undefined;
    if (!taskId && !traceId && !fileName && batch === null && !rowFrom && !rowTo && !errorCode) return jsonError("至少提供一个 Trace 查询条件", 400);
    const tasks = await prisma.importTask.findMany({
      where: {
        ...(taskId ? { id: taskId } : {}),
        ...(traceId ? { traceId } : {}),
        ...(fileName ? { fileName: { contains: fileName, mode: "insensitive" } } : {}),
        ...(batch !== null ? { batches: { some: { batchIndex: Number(batch) } } } : {}),
        ...(errorCode || rowFrom || rowTo ? { errors: { some: { ...(errorCode ? { errorCode } : {}), ...(rowFrom || rowTo ? { rowNumber: { ...(rowFrom ? { gte: Number(rowFrom) } : {}), ...(rowTo ? { lte: Number(rowTo) } : {}) } } : {}) } } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, traceId: true, fileName: true, status: true, createdAt: true, processedRows: true, failedRows: true },
    });
    return Response.json({ tasks });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Trace 检索失败");
  }
}
