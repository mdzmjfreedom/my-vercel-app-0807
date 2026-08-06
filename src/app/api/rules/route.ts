import { jsonError, readJson } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import type { ParseRule } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  try {
    const rules = await prisma.parseRule.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return Response.json({
      success: true,
      rules: rules.map((rule) => ({
        id: rule.id,
        ruleName: rule.ruleName,
        fileType: rule.fileType,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
        config: JSON.parse(rule.configJson) as ParseRule,
      })),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "读取规则失败");
  }
}

export async function POST(req: Request) {
  try {
    const body = await readJson<{ rule: ParseRule }>(req);
    if (!body.rule?.ruleName || !body.rule?.fileType || !body.rule?.mode) {
      return jsonError("规则缺少名称、文件类型或解析模式", 400);
    }

    const saved = await prisma.parseRule.create({
      data: {
        ruleName: body.rule.ruleName,
        fileType: body.rule.fileType,
        configJson: JSON.stringify(body.rule),
      },
    });

    return Response.json({
      success: true,
      rule: {
        id: saved.id,
        ruleName: saved.ruleName,
        fileType: saved.fileType,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
        config: { ...body.rule, id: saved.id },
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "保存规则失败");
  }
}
