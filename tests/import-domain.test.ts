import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { ParserEngine } from "../src/lib/parser-engine";
import { errorCode, estimateFileRows, redactRaw, splitRanges } from "../src/lib/import-service";
import type { ParseRule, ParsedOrder } from "../src/lib/types";
import { aggregateOrders, validateOrders } from "../src/lib/types";

test("10,000 rows are split into stable 500-row units", () => {
  const ranges = splitRanges(10000, 500);
  assert.equal(ranges.length, 20);
  assert.deepEqual(ranges[0], { index: 0, start: 1, end: 500 });
  assert.deepEqual(ranges.at(-1), { index: 19, start: 9501, end: 10000 });
});

test("sensitive error values are masked and error codes stay explainable", () => {
  assert.equal(redactRaw("receiverPhone", "13812345678"), "138****5678");
  assert.equal(redactRaw("receiverAddress", "上海市浦东新区测试路100号"), "上海市浦****0号");
  assert.equal(errorCode({ field: "skuCode", message: "SKU 主数据不存在" }), "E001");
  assert.equal(errorCode({ field: "qty", message: "数量错误" }), "E004");
});

test("V2 rule engine parses a generic Excel table without file-name branching", async () => {
  const worksheet = XLSX.utils.aoa_to_sheet([["外部编码", "收货门店", "SKU编码", "商品名", "数量"], ["ORDER-1", "上海一店", "SKU_00001", "测试商品", 2]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "任意名称");
  const data = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const file = new File([data], "arbitrary.xlsx");
  const rule: ParseRule = { ruleName: "generic", fileType: "excel", mode: "table", table: { headerRow: 0, dataStartRow: 1, fieldMappings: { externalCode: { kind: "column", header: "外部编码" }, receiverShop: { kind: "column", header: "收货门店" }, skuCode: { kind: "column", header: "SKU编码" }, skuName: { kind: "column", header: "商品名" }, qty: { kind: "column", header: "数量" } } } };
  const rows = await ParserEngine.parse(file, rule);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].skuCode, "SKU_00001");
  assert.equal(rows[0].qty, 2);
  assert.equal(await estimateFileRows(file), 1);
});

test("row validation supports partial success and order aggregation", () => {
  const valid: ParsedOrder = { id: "1", externalCode: "ORDER-1", receiverShop: "门店", skuCode: "SKU_00001", skuName: "商品", qty: 1 };
  const invalid: ParsedOrder = { id: "2", externalCode: "ORDER-2", receiverShop: "门店", skuCode: "", skuName: "商品", qty: 0 };
  const issues = validateOrders([valid, invalid]);
  assert.equal(issues.filter((issue) => issue.severity === "error" && issue.rowIndex === 0).length, 0);
  assert.ok(issues.filter((issue) => issue.severity === "error" && issue.rowIndex === 1).length >= 2);
  assert.equal(aggregateOrders([valid, { ...valid, id: "3", skuCode: "SKU_00002" }])[0].skuLineCount, 2);
});
