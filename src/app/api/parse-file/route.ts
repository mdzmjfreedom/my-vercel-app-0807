import { jsonError } from "@/lib/api-helpers";
import { ParserEngine } from "@/lib/parser-engine";
import { prisma } from "@/lib/prisma";
import type { ParseRule } from "@/lib/types";
import { validateOrders } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const ruleJson = form.get("rule");
    const ruleId = form.get("ruleId");

    if (!(file instanceof File)) {
      return jsonError("请上传要解析的文件", 400);
    }

    let rule: ParseRule | null = null;
    if (typeof ruleJson === "string" && ruleJson.trim()) {
      rule = JSON.parse(ruleJson) as ParseRule;
    } else if (typeof ruleId === "string" && ruleId.trim()) {
      const saved = await prisma.parseRule.findUnique({ where: { id: ruleId } });
      if (!saved) return jsonError("选择的解析规则不存在", 404);
      rule = JSON.parse(saved.configJson) as ParseRule;
    }

    if (!rule) {
      return jsonError("请选择或提供一条解析规则", 400);
    }

    const started = performance.now();
    const orders = await ParserEngine.parse(file, rule);
    const existingCodes = await prisma.order.findMany({
      where: { externalCode: { not: null } },
      select: { externalCode: true },
      distinct: ["externalCode"],
      take: 20000,
    });
    const issues = validateOrders(
      orders,
      existingCodes.map((item) => item.externalCode).filter((code): code is string => Boolean(code)),
    );

    return Response.json({
      success: true,
      orders,
      issues,
      metrics: {
        rowCount: orders.length,
        elapsedMs: Math.round(performance.now() - started),
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "文件解析失败");
  }
}
