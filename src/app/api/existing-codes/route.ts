import { jsonError } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  try {
    const rows = await prisma.order.findMany({
      where: { externalCode: { not: null } },
      select: { externalCode: true },
      distinct: ["externalCode"],
      take: 20000,
    });

    return Response.json({
      success: true,
      codes: rows.map((row) => row.externalCode).filter(Boolean),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "读取历史外部编码失败");
  }
}
