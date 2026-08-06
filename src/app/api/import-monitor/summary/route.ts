import { jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  try {
    const since = new Date(Date.now() - 5 * 60 * 1000);
    const [pending, failedTasks, completedTasks, logs, errors] = await Promise.all([
      prisma.importTaskBatch.count({ where: { status: { in: ["PENDING", "RETRY", "PROCESSING"] } } }),
      prisma.importTask.count({ where: { status: { in: ["FAILED", "PARTIAL_SUCCESS"] }, createdAt: { gte: since } } }),
      prisma.importTask.findMany({ where: { completedAt: { gte: since } }, select: { successRows: true, completedAt: true } }),
      prisma.batchPerformanceLog.findMany({ where: { createdAt: { gte: since } }, select: { parseDurationMs: true, ruleDurationMs: true, validateDurationMs: true, insertDurationMs: true, totalDurationMs: true, status: true, taskId: true, unitId: true, createdAt: true } }),
      prisma.importTaskError.groupBy({ by: ["errorCode"], _count: { _all: true }, where: { createdAt: { gte: since } } }),
    ]);
    const values = (key: "parseDurationMs" | "ruleDurationMs" | "validateDurationMs" | "insertDurationMs" | "totalDurationMs") => logs.map((log) => log[key]).sort((a, b) => a - b);
    const percentile = (items: number[], p: number) => items.length ? items[Math.min(items.length - 1, Math.floor(items.length * p))] : 0;
    const throughputSeries = Array.from({ length: 5 }, (_, index) => { const start = new Date(Date.now() - (5 - index) * 60000); const end = new Date(start.getTime() + 60000); return { minute: start.toISOString(), rows: completedTasks.filter((task) => task.completedAt && task.completedAt >= start && task.completedAt < end).reduce((sum, task) => sum + task.successRows, 0) }; });
    const totalSuccessRows = completedTasks.reduce((sum, task) => sum + task.successRows, 0);
    return Response.json({ generated_at: new Date().toISOString(), throughput_per_minute: Math.round(totalSuccessRows / 5), throughput_series: throughputSeries, queue_backlog_batches: pending, queue_alert: pending > 10, failed_tasks_5m: failedTasks, stage_latency_ms: { parse: { p50: percentile(values("parseDurationMs"), .5), p95: percentile(values("parseDurationMs"), .95), p99: percentile(values("parseDurationMs"), .99) }, rule: { p50: percentile(values("ruleDurationMs"), .5), p95: percentile(values("ruleDurationMs"), .95), p99: percentile(values("ruleDurationMs"), .99) }, validate: { p50: percentile(values("validateDurationMs"), .5), p95: percentile(values("validateDurationMs"), .95), p99: percentile(values("validateDurationMs"), .99) }, insert: { p50: percentile(values("insertDurationMs"), .5), p95: percentile(values("insertDurationMs"), .95), p99: percentile(values("insertDurationMs"), .99) }, total: { p50: percentile(values("totalDurationMs"), .5), p95: percentile(values("totalDurationMs"), .95), p99: percentile(values("totalDurationMs"), .99) } }, error_distribution: errors.map((error) => ({ error_code: error.errorCode, count: error._count._all })) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "读取监控聚合失败");
  }
}
