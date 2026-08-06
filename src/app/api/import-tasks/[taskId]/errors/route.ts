import { jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(req: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await context.params;
    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("page_size") || 50)));
    const batch = url.searchParams.get("batch");
    const errorCode = url.searchParams.get("error_code");
    const where = { taskId, ...(batch ? { batchIndex: Number(batch) } : {}), ...(errorCode ? { errorCode } : {}) };
    const [errors, total] = await Promise.all([prisma.importTaskError.findMany({ where, orderBy: [{ rowNumber: "asc" }, { createdAt: "asc" }], skip: (page - 1) * pageSize, take: pageSize }), prisma.importTaskError.count({ where })]);
    return Response.json({ task_id: taskId, errors, page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "读取错误明细失败");
  }
}
