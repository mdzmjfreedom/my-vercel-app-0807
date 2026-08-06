import { jsonError, readJson } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import type { ParseRule } from "@/lib/types";

export const runtime = "nodejs";

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await readJson<{ rule: ParseRule }>(req);

    if (!body.rule?.ruleName || !body.rule?.fileType || !body.rule?.mode) {
      return jsonError("规则缺少名称、文件类型或解析模式", 400);
    }

    const updated = await prisma.parseRule.update({
      where: { id },
      data: {
        ruleName: body.rule.ruleName,
        fileType: body.rule.fileType,
        configJson: JSON.stringify({ ...body.rule, id }),
      },
    });

    return Response.json({
      success: true,
      rule: {
        id: updated.id,
        ruleName: updated.ruleName,
        fileType: updated.fileType,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        config: JSON.parse(updated.configJson),
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "更新规则失败");
  }
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await prisma.parseRule.delete({ where: { id } });
    return Response.json({ success: true });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "删除规则失败");
  }
}
