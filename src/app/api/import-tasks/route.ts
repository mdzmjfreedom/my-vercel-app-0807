import { after } from "next/server";
import { jsonError } from "@/lib/api-helpers";
import { createImportTask, dispatchOutbox } from "@/lib/import-service";
import { validateImportBlob } from "@/lib/import-storage";
import { prisma } from "@/lib/prisma";
import type { ParseRule } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = await req.json() as {
        blobUrl?: unknown;
        fileName?: unknown;
        totalRows?: unknown;
        ruleId?: unknown;
        rule?: unknown;
      };
      if (typeof body.blobUrl !== "string" || typeof body.fileName !== "string") {
        return jsonError("请提供已上传的 Blob 文件地址", 400);
      }
      const ruleId = typeof body.ruleId === "string" ? body.ruleId : "";
      let rule = body.rule && typeof body.rule === "object" ? body.rule as ParseRule : null;
      if (!rule && ruleId) {
        const saved = await prisma.parseRule.findUnique({ where: { id: ruleId } });
        if (!saved) return jsonError("选择的解析规则不存在", 404);
        rule = JSON.parse(saved.configJson) as ParseRule;
      }
      if (!rule) return jsonError("请提供解析规则", 400);
      const totalRows = typeof body.totalRows === "number" && Number.isFinite(body.totalRows)
        ? Math.min(1_000_000, Math.max(0, Math.floor(body.totalRows)))
        : 0;
      const filePath = await validateImportBlob(body.blobUrl, body.fileName);
      const result = await createImportTask({ filePath, fileName: body.fileName, totalRows, rule, ruleId: ruleId || rule.id });
      after(() => dispatchOutbox(100));
      return Response.json({ task_id: result.task.id, trace_id: result.task.traceId, status: result.task.status, total_rows: result.task.totalRows, total_batches: result.totalBatches }, { status: 202 });
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonError("请上传要导入的文件", 400);
    const ruleId = typeof form.get("ruleId") === "string" ? String(form.get("ruleId")) : "";
    const ruleJson = typeof form.get("rule") === "string" ? String(form.get("rule")) : "";
    let rule: ParseRule | null = ruleJson ? JSON.parse(ruleJson) as ParseRule : null;
    if (!rule && ruleId) {
      const saved = await prisma.parseRule.findUnique({ where: { id: ruleId } });
      if (!saved) return jsonError("选择的解析规则不存在", 404);
      rule = JSON.parse(saved.configJson) as ParseRule;
    }
    if (!rule) return jsonError("请提供解析规则", 400);
    const result = await createImportTask({ file, rule, ruleId: ruleId || rule.id });
    after(() => dispatchOutbox(100));
    return Response.json({ task_id: result.task.id, trace_id: result.task.traceId, status: result.task.status, total_rows: result.task.totalRows, total_batches: result.totalBatches }, { status: 202 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "创建异步导入任务失败");
  }
}
