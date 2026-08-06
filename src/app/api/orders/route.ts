import { Prisma } from "@prisma/client";
import { jsonError, readJson } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";
import type { ParsedOrder } from "@/lib/types";
import { aggregateOrders, normalizeText, toPositiveNumber, validateOrders } from "@/lib/types";

export const runtime = "nodejs";

type ImportedOrderRow = {
  id: string;
  externalCode: string | null;
  receiverShop: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  skuCode: string;
  skuName: string;
  qty: number;
  skuSpec: string | null;
  remark: string | null;
  createdAt: Date;
};

type ImportedOrderGroup = {
  groupKey: string;
  externalCode: string | null;
  receiverShop: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  skuLineCount: number;
  totalQty: number;
  createdAt: Date;
  firstCreatedAt: Date;
  lastCreatedAt: Date;
  hasReceiverConflict: boolean;
  items: ImportedOrderRow[];
};

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = normalizeText(url.searchParams.get("q"));
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") ?? 20)));
    const createdFrom = normalizeText(url.searchParams.get("createdFrom"));
    const createdTo = normalizeText(url.searchParams.get("createdTo"));

    const where: Prisma.OrderWhereInput = {
      ...(q ? { OR: buildSearchWhere(q) } : {}),
      ...(createdFrom || createdTo
        ? {
            createdAt: {
              ...(createdFrom ? { gte: new Date(createdFrom) } : {}),
              ...(createdTo ? { lte: new Date(`${createdTo}T23:59:59`) } : {}),
            },
          }
        : {}),
    };

    const matchedRows = await prisma.order.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20000,
    });
    const rows = q ? await expandMatchedRowsToFullOutboundOrders(matchedRows) : matchedRows;
    const groups = groupImportedOrders(rows);
    const total = groups.length;
    const orders = groups.slice((page - 1) * pageSize, page * pageSize);

    return Response.json({ success: true, orders, total, page, pageSize, rowTotal: rows.length });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "读取运单失败");
  }
}

export async function POST(req: Request) {
  try {
    const body = await readJson<{ orders: ParsedOrder[] }>(req);
    const orders = Array.isArray(body.orders) ? body.orders : [];
    if (!orders.length) return jsonError("没有可提交的订单数据", 400);
    const groups = aggregateOrders(orders);
    const incomingCodes = Array.from(
      new Set(orders.map((order) => normalizeText(order.externalCode)).filter(Boolean)),
    );

    const result = await prisma.$transaction(async (tx) => {
      const existingCodes = await tx.order.findMany({
        where: incomingCodes.length ? { externalCode: { in: incomingCodes } } : { externalCode: { not: null } },
        select: { externalCode: true },
        distinct: ["externalCode"],
        take: 20000,
      });

      const issues = validateOrders(
        orders,
        existingCodes.map((item) => item.externalCode).filter((code): code is string => Boolean(code)),
      ).filter((issue) => issue.severity === "error");

      if (issues.length) {
        return { ok: false as const, issues };
      }

      const created = await tx.order.createMany({
        data: orders.map((order) => ({
          externalCode: normalizeText(order.externalCode) || null,
          receiverShop: normalizeText(order.receiverShop) || null,
          receiverName: normalizeText(order.receiverName) || null,
          receiverPhone: normalizeText(order.receiverPhone) || null,
          receiverAddress: normalizeText(order.receiverAddress) || null,
          skuCode: normalizeText(order.skuCode),
          skuName: normalizeText(order.skuName),
          qty: Math.round(toPositiveNumber(order.qty)),
          skuSpec: normalizeText(order.skuSpec) || null,
          remark: normalizeText(order.remark) || null,
        })),
      });

      return { ok: true as const, count: created.count };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });

    if (!result.ok) {
      return Response.json({ success: false, error: "存在校验错误，无法提交", issues: result.issues }, { status: 422 });
    }

    return Response.json({
      success: true,
      summary: {
        successCount: result.count,
        failedCount: 0,
        outboundOrderCount: groups.length,
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "提交下单失败");
  }
}

function groupImportedOrders(rows: ImportedOrderRow[]): ImportedOrderGroup[] {
  const groups = new Map<string, ImportedOrderGroup>();

  rows.forEach((row) => {
    const externalCode = normalizeText(row.externalCode);
    const groupKey = externalCode || `row-${row.id}`;
    const receiverSignature = getReceiverSignature(row);
    const existing = groups.get(groupKey);

    if (!existing) {
      groups.set(groupKey, {
        groupKey,
        externalCode: externalCode || null,
        receiverShop: row.receiverShop,
        receiverName: row.receiverName,
        receiverPhone: row.receiverPhone,
        receiverAddress: row.receiverAddress,
        skuLineCount: 1,
        totalQty: row.qty,
        createdAt: row.createdAt,
        firstCreatedAt: row.createdAt,
        lastCreatedAt: row.createdAt,
        hasReceiverConflict: false,
        items: [row],
      });
      return;
    }

    existing.items.push(row);
    existing.skuLineCount += 1;
    existing.totalQty += row.qty;
    existing.firstCreatedAt = existing.firstCreatedAt < row.createdAt ? existing.firstCreatedAt : row.createdAt;
    existing.lastCreatedAt = existing.lastCreatedAt > row.createdAt ? existing.lastCreatedAt : row.createdAt;
    existing.createdAt = existing.lastCreatedAt;
    existing.hasReceiverConflict ||= getReceiverSignature(existing.items[0]) !== receiverSignature;
  });

  return Array.from(groups.values())
    .map((group) => ({ ...group, items: sortImportedOrderItems(group.items) }))
    .sort((first, second) => second.lastCreatedAt.getTime() - first.lastCreatedAt.getTime());
}

function buildSearchWhere(q: string): Prisma.OrderWhereInput[] {
  return [
    { externalCode: { contains: q, mode: "insensitive" } },
    { receiverName: { contains: q, mode: "insensitive" } },
    { receiverShop: { contains: q, mode: "insensitive" } },
    { receiverPhone: { contains: q, mode: "insensitive" } },
    { skuCode: { contains: q, mode: "insensitive" } },
    { skuName: { contains: q, mode: "insensitive" } },
  ];
}

async function expandMatchedRowsToFullOutboundOrders(rows: ImportedOrderRow[]): Promise<ImportedOrderRow[]> {
  const externalCodes = Array.from(
    new Set(rows.map((row) => normalizeText(row.externalCode)).filter(Boolean)),
  );
  if (!externalCodes.length) return rows;

  const expandedRows = await prisma.order.findMany({
    where: { externalCode: { in: externalCodes } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20000,
  });
  const byId = new Map<string, ImportedOrderRow>();
  [...expandedRows, ...rows].forEach((row) => byId.set(row.id, row));

  return Array.from(byId.values()).sort((first, second) => second.createdAt.getTime() - first.createdAt.getTime());
}

function sortImportedOrderItems(items: ImportedOrderRow[]): ImportedOrderRow[] {
  return [...items].sort(
    (first, second) =>
      normalizeText(first.skuCode).localeCompare(normalizeText(second.skuCode), "zh-CN", { numeric: true }) ||
      normalizeText(first.skuName).localeCompare(normalizeText(second.skuName), "zh-CN", { numeric: true }) ||
      first.createdAt.getTime() - second.createdAt.getTime(),
  );
}

function getReceiverSignature(row: Pick<ImportedOrderRow, "receiverShop" | "receiverName" | "receiverPhone" | "receiverAddress">): string {
  return [
    normalizeText(row.receiverShop),
    normalizeText(row.receiverName),
    normalizeText(row.receiverPhone),
    normalizeText(row.receiverAddress),
  ].join("|");
}
