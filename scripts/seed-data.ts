import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SKU_COUNT = Number(process.env.SEED_SKU_COUNT || 20000);
const ORDER_COUNT = Number(process.env.SEED_ORDER_COUNT || 10000);
const ORDER_PREFIX = process.env.SEED_ORDER_PREFIX || "LOAD";

async function main() {
  const skus = Array.from({ length: SKU_COUNT }, (_, index) => {
    const code = `SKU_${String(index + 1).padStart(5, "0")}`;
    return { skuCode: code, name: `压测商品 ${index + 1}`, spec: `${(index % 8) + 1} 规格`, unit: index % 3 === 0 ? "箱" : "件" };
  });
  const rows = Array.from({ length: ORDER_COUNT }, (_, index) => {
    const valid = index % 997 !== 0;
    const sku = valid ? skus[(index * 17) % skus.length].skuCode : `SKU_INVALID_${index}`;
    return { 外部编码: `${ORDER_PREFIX}_${String(index + 1).padStart(6, "0")}`, 收货门店: `压测门店 ${(index % 50) + 1}`, 收件人姓名: `测试收件人 ${(index % 100) + 1}`, 收件人电话: `138${String(10000000 + index).slice(-8)}`, 收件人地址: `测试地址 ${(index % 80) + 1} 号`, SKU物品编码: sku, SKU物品名称: `压测商品 ${((index * 17) % skus.length) + 1}`, SKU发货数量: (index % 5) + 1, SKU规格型号: `${(index % 8) + 1} 规格`, 备注: "V4 load test" };
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Orders");
  const outputDir = path.join(process.cwd(), "test-data");
  await mkdir(outputDir, { recursive: true });
  XLSX.writeFile(workbook, path.join(outputDir, "10000-orders.xlsx"), { compression: true });
  if (process.env.GENERATE_FILE_ONLY !== "1") {
    await prisma.skuMaster.deleteMany();
    for (let offset = 0; offset < skus.length; offset += 1000) await prisma.skuMaster.createMany({ data: skus.slice(offset, offset + 1000) });
  }
  console.log(JSON.stringify({ skuCount: SKU_COUNT, orderCount: ORDER_COUNT, orderPrefix: ORDER_PREFIX, file: "test-data/10000-orders.xlsx", invalidSkuRows: Math.ceil(ORDER_COUNT / 997) }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
