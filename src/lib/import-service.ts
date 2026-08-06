import { randomUUID, createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import { ParserEngine } from "@/lib/parser-engine";
import { prisma } from "@/lib/prisma";
import { readImportFile, readParsedBatchSnapshot, saveImportFile, writeParsedBatchSnapshots } from "@/lib/import-storage";
import { enqueueImportEvent, hasExternalQueue } from "@/lib/import-queue";
import type { OrderField, ParsedOrder, ParseRule } from "@/lib/types";
import { normalizeText, toPositiveNumber, validateOrders } from "@/lib/types";

export const BATCH_SIZE = Number(process.env.IMPORT_BATCH_SIZE || 500);
export const MAX_RETRIES = Number(process.env.IMPORT_MAX_RETRIES || 3);

export type ImportEvent = {
  event_id: string;
  event_type: string;
  schema_version: number;
  aggregate_id: string;
  trace_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
};

export async function estimateFileRows(file: File): Promise<number> {
  const suffix = file.name.split(".").pop()?.toLowerCase();
  if (suffix !== "xlsx" && suffix !== "xls") return 0;
  const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", dense: true, cellFormula: false });
  return workbook.SheetNames.reduce((count, name) => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, raw: false, blankrows: false });
    return count + Math.max(0, rows.length - 1);
  }, 0);
}

export async function createImportTask(input: {
  file?: File;
  filePath?: string;
  fileName?: string;
  totalRows?: number;
  rule: ParseRule;
  ruleId?: string | null;
}) {
  const taskId = `task_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const traceId = `trace_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const fileName = input.file?.name ?? input.fileName;
  if (!fileName) throw new Error("导入文件名不能为空");
  const filePath = input.filePath ?? (input.file ? await saveImportFile(taskId, input.file) : "");
  if (!filePath) throw new Error("导入文件地址不能为空");
  const totalRows = input.totalRows !== undefined
    ? Math.max(0, Math.floor(input.totalRows))
    : input.file
      ? await estimateFileRows(input.file)
      : 0;
  const taskEvent = makeOutbox({ taskId, traceId, eventType: "ImportTaskCreated", payload: { task_id: taskId, total_rows: totalRows } });
  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.importTask.create({
      data: {
        id: taskId,
        traceId,
        fileName,
        filePath,
        ruleId: input.ruleId || input.rule.id || null,
        ruleJson: JSON.stringify(input.rule),
        totalRows,
        totalBatches: 0,
      },
    });
    await tx.traceEvent.create({
      data: { id: randomUUID(), taskId, traceId, eventName: "ImportTaskCreated", eventStatus: "INFO", message: "任务已创建，等待异步投递" },
    });
    await tx.eventOutbox.create({ data: taskEvent });
    return created;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 });
  return { task, totalBatches: 0 };
}

export function splitRanges(totalRows: number, batchSize: number) {
  if (!totalRows) return [{ index: 0, start: 1, end: 1 }];
  const ranges: Array<{ index: number; start: number; end: number }> = [];
  for (let start = 1, index = 0; start <= totalRows; start += batchSize, index += 1) {
    ranges.push({ index, start, end: Math.min(totalRows, start + batchSize - 1) });
  }
  return ranges;
}

function makeOutbox(input: { taskId: string; traceId: string; unitId?: string; batchId?: string; eventType: string; payload: Record<string, unknown> }) {
  const event: ImportEvent = {
    event_id: `evt_${randomUUID().replace(/-/g, "")}`,
    event_type: input.eventType,
    schema_version: 1,
    aggregate_id: input.taskId,
    trace_id: input.traceId,
    occurred_at: new Date().toISOString(),
    payload: input.payload,
  };
  return { id: event.event_id, aggregateId: input.taskId, eventType: input.eventType, schemaVersion: 1, payload: JSON.stringify(event), traceId: input.traceId, taskId: input.taskId, unitId: input.unitId, batchId: input.batchId };
}

export async function dispatchOutbox(limit = 4): Promise<number> {
  let dispatched = 0;
  while (dispatched < limit) {
    const candidates = await prisma.eventOutbox.findMany({
      where: { status: { in: ["PENDING", "FAILED"] }, nextRetryAt: { lte: new Date() } },
      orderBy: { createdAt: "asc" }, take: limit - dispatched,
    });
    if (!candidates.length) break;
    for (const event of candidates) {
      const result = await prisma.eventOutbox.updateMany({ where: { id: event.id, status: event.status }, data: { status: "DISPATCHING" } });
      if (!result.count) continue;
      try {
        if (hasExternalQueue()) {
          await enqueueImportEvent(event.id);
          await prisma.eventOutbox.update({ where: { id: event.id }, data: { status: "SENT", sentAt: new Date(), lastError: null } });
        } else {
          await prisma.eventOutbox.update({ where: { id: event.id }, data: { status: "SENT", sentAt: new Date(), lastError: null } });
          await processImportEvent(event.id);
        }
        dispatched += 1;
      } catch (error) {
        const retryCount = event.retryCount + 1;
        await prisma.eventOutbox.update({ where: { id: event.id }, data: { status: "FAILED", retryCount, nextRetryAt: new Date(Date.now() + Math.min(60000, retryCount * 5000)), lastError: error instanceof Error ? error.message : "dispatch failed" } });
      }
    }
  }
  return dispatched;
}

export async function processImportEvent(outboxId: string): Promise<void> {
  const event = await prisma.eventOutbox.findUnique({ where: { id: outboxId }, select: { unitId: true } });
  if (!event) return;
  if (!event.unitId) return prepareImportTask(outboxId);
  return processImportBatch(outboxId);
}

async function prepareImportTask(outboxId: string): Promise<void> {
  const event = await prisma.eventOutbox.findUnique({ where: { id: outboxId }, include: { task: true } });
  if (!event || event.unitId || event.task.totalBatches > 0) return;
  const staleBefore = new Date(Date.now() - Number(process.env.IMPORT_BATCH_LOCK_TIMEOUT_SECONDS || 120) * 1000);
  const claim = await prisma.importTask.updateMany({
    where: {
      id: event.taskId,
      OR: [{ status: "PENDING" }, { status: "PREPARING", updatedAt: { lt: staleBefore } }],
    },
    data: { status: "PREPARING" },
  });
  if (!claim.count) {
    const fresh = await prisma.importTask.findUnique({ where: { id: event.taskId }, select: { status: true, totalBatches: true } });
    if (fresh?.totalBatches) return;
    throw new Error("导入文件正在由另一个 Worker 准备");
  }

  try {
    const rule = JSON.parse(event.task.ruleJson) as ParseRule;
    const file = await readImportFile(event.task.filePath, event.task.fileName);
    const rows = await ParserEngine.parse(file, rule);
    await prisma.traceEvent.create({ data: { id: randomUUID(), taskId: event.taskId, traceId: event.traceId, eventName: "ImportFileParsed", eventStatus: rows.length ? "SUCCEEDED" : "FAILED", message: `解析得到 ${rows.length} 行，文件大小 ${file.size} 字节` } });
    if (!rows.length) throw new Error("文件解析结果为空，请检查文件内容和解析规则");
    const ranges = splitRanges(rows.length, BATCH_SIZE);
    const batchRows = ranges.map((range) => {
      const unitId = `${event.taskId}_unit_${String(range.index).padStart(4, "0")}`;
      return { id: unitId, taskId: event.taskId, unitId, batchIndex: range.index, startRow: range.start, endRow: range.end };
    });
    const chunks = ranges.map((range) => rows.slice(range.start - 1, range.end));
    await writeParsedBatchSnapshots(event.task.filePath, chunks);
    const batchEvents = ranges.map((range, index) => {
      const batch = batchRows[index];
      return makeOutbox({
        taskId: event.taskId,
        traceId: event.traceId,
        unitId: batch.unitId,
        batchId: batch.id,
        eventType: "ImportBatchCreated",
        payload: { task_id: event.taskId, unit_id: batch.unitId, start_row: range.start, end_row: range.end },
      });
    });
    await prisma.$transaction(async (tx) => {
      await tx.importTaskBatch.createMany({ data: batchRows, skipDuplicates: true });
      await tx.eventOutbox.createMany({ data: batchEvents, skipDuplicates: true });
      await tx.importTask.update({ where: { id: event.taskId }, data: { status: "PROCESSING", totalRows: rows.length, totalBatches: ranges.length } });
      await tx.eventOutbox.update({ where: { id: event.id }, data: { status: "SENT", sentAt: new Date(), lastError: null } });
      await tx.traceEvent.create({ data: { id: randomUUID(), taskId: event.taskId, traceId: event.traceId, eventName: "ImportFilePrepared", eventStatus: "SUCCEEDED", message: `文件解析完成，生成 ${ranges.length} 个批次` } });
    }, { timeout: 15000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "导入文件准备失败";
    await prisma.$transaction([
      prisma.importTask.update({ where: { id: event.taskId }, data: { status: "PENDING" } }),
      prisma.eventOutbox.update({ where: { id: event.id }, data: { retryCount: { increment: 1 }, lastError: message } }),
      prisma.traceEvent.create({ data: { id: randomUUID(), taskId: event.taskId, traceId: event.traceId, eventName: "ImportFilePrepareFailed", eventStatus: "FAILED", message } }),
    ]);
    throw error;
  }
}

export async function processImportBatch(outboxId: string): Promise<void> {
  const event = await prisma.eventOutbox.findUnique({ where: { id: outboxId } });
  if (!event?.unitId || !event.batchId) return;
  const batch = await prisma.importTaskBatch.findUnique({ where: { id: event.batchId }, include: { task: true } });
  if (!batch) return;
  const staleBefore = new Date(Date.now() - Number(process.env.IMPORT_BATCH_LOCK_TIMEOUT_SECONDS || 120) * 1000);
  const claim = await prisma.importTaskBatch.updateMany({
    where: {
      id: batch.id,
      OR: [
        { status: { in: ["PENDING", "RETRY"] } },
        { status: "PROCESSING", lockedAt: { lt: staleBefore } },
      ],
    },
    data: { status: "PROCESSING", lockedAt: new Date(), lastError: null },
  });
  if (!claim.count) return;
  const started = performance.now();
  await addTrace(batch.task, batch, "ImportBatchStarted", "STARTED", "批次开始消费");
  try {
    const parseStarted = performance.now();
    const rows = await readParsedBatchSnapshot<ParsedOrder[]>(batch.task.filePath, batch.batchIndex);
    const parseDurationMs = Math.round(performance.now() - parseStarted);
    const validationStarted = performance.now();
    const skuCodes = Array.from(new Set(rows.map((row) => normalizeText(row.skuCode)).filter(Boolean)));
    let knownSkus = new Set<string>();
    let degraded = false;
    try {
      const skuRows = skuCodes.length ? await prisma.skuMaster.findMany({ where: { skuCode: { in: skuCodes } }, select: { skuCode: true } }) : [];
      knownSkus = new Set(skuRows.map((row) => row.skuCode));
    } catch (error) {
      degraded = true;
      await addTrace(batch.task, batch, "ImportTaskDegraded", "WARN", `SKU 主数据查询异常，已降级校验：${error instanceof Error ? error.message : "unknown"}`);
    }
    const existingCodes = Array.from(new Set(rows.map((row) => normalizeText(row.externalCode)).filter(Boolean)));
    const history = existingCodes.length ? await prisma.order.findMany({ where: { externalCode: { in: existingCodes } }, select: { externalCode: true } }) : [];
    const issues = validateOrders(rows, history.map((row) => row.externalCode).filter((value): value is string => Boolean(value)));
    if (!degraded) rows.forEach((row, index) => { if (normalizeText(row.skuCode) && !knownSkus.has(normalizeText(row.skuCode))) issues.push({ rowIndex: index, field: "skuCode", message: "SKU 主数据不存在", severity: "error" }); });
    const validateDurationMs = Math.round(performance.now() - validationStarted);
    const errorByRow = new Map<number, typeof issues>();
    issues.filter((issue) => issue.severity === "error").forEach((issue) => errorByRow.set(issue.rowIndex, [...(errorByRow.get(issue.rowIndex) ?? []), issue]));
    const validRows = rows.map((row, index) => ({ row, index })).filter(({ index }) => !errorByRow.has(index));
    const insertStarted = performance.now();
    if (validRows.length) {
      await prisma.order.createMany({
        data: validRows.map(({ row, index }) => ({
          dedupeKey: `${batch.taskId}:${batch.batchIndex}:${batch.startRow + index}`,
          externalCode: normalizeText(row.externalCode) || null,
          receiverShop: normalizeText(row.receiverShop) || null,
          receiverName: normalizeText(row.receiverName) || null,
          receiverPhone: normalizeText(row.receiverPhone) || null,
          receiverAddress: normalizeText(row.receiverAddress) || null,
          skuCode: normalizeText(row.skuCode), skuName: normalizeText(row.skuName), qty: Math.round(toPositiveNumber(row.qty)),
          skuSpec: normalizeText(row.skuSpec) || null, remark: normalizeText(row.remark) || null,
        })), skipDuplicates: true,
      });
    }
    const insertDurationMs = Math.round(performance.now() - insertStarted);
    const errors = issues.filter((issue) => issue.severity === "error").map((issue) => {
      const row = rows[issue.rowIndex];
      return { id: randomUUID(), taskId: batch.taskId, batchId: batch.id, unitId: batch.unitId, batchIndex: batch.batchIndex, rowNumber: batch.startRow + issue.rowIndex, fieldName: issue.field, rawValue: redactRaw(issue.field, row?.[issue.field as OrderField]), errorCode: errorCode(issue), errorReason: explain(issue), traceId: batch.task.traceId };
    });
    if (errors.length) await prisma.importTaskError.createMany({ data: errors, skipDuplicates: true });
    const failedRows = new Set(errors.map((error) => error.rowNumber)).size;
    const successRows = Math.max(0, rows.length - failedRows);
    const totalDurationMs = Math.round(performance.now() - started);
    await prisma.$transaction(async (tx) => {
      await tx.batchPerformanceLog.create({ data: { taskId: batch.taskId, batchId: batch.id, unitId: batch.unitId, batchIndex: batch.batchIndex, parseDurationMs, ruleDurationMs: 0, validateDurationMs, insertDurationMs, totalDurationMs, status: failedRows ? "PARTIAL_SUCCESS" : "SUCCEEDED", traceId: batch.task.traceId } });
      const updated = await tx.importTaskBatch.updateMany({ where: { id: batch.id, status: "PROCESSING" }, data: { status: "COMPLETED", processedRows: rows.length, successRows, failedRows, completedAt: new Date() } });
      if (updated.count) await tx.importTask.update({ where: { id: batch.taskId }, data: { processedRows: { increment: rows.length }, successRows: { increment: successRows }, failedRows: { increment: failedRows }, completedBatches: { increment: 1 }, ...(degraded ? { degraded: true } : {}) } });
      await tx.eventOutbox.update({ where: { id: event.id }, data: { status: "SENT", sentAt: new Date(), lastError: null } });
    });
    await addTrace(batch.task, batch, failedRows ? "ImportBatchSucceeded" : "ImportBatchSucceeded", failedRows ? "PARTIAL_SUCCESS" : "SUCCEEDED", `批次完成：成功 ${successRows} 行，失败 ${failedRows} 行`);
    await aggregateTask(batch.taskId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "批次处理失败";
    const retryCount = batch.retryCount + 1;
    await prisma.importTaskBatch.update({ where: { id: batch.id }, data: { status: retryCount <= MAX_RETRIES ? "RETRY" : "FAILED", retryCount, lastError: message, completedAt: retryCount > MAX_RETRIES ? new Date() : null } });
    await prisma.eventOutbox.update({ where: { id: event.id }, data: { status: retryCount <= MAX_RETRIES ? "FAILED" : "SENT", retryCount, nextRetryAt: new Date(Date.now() + Math.min(60000, retryCount * 5000)), lastError: message } });
    await addTrace(batch.task, batch, "ImportBatchFailed", "FAILED", `${message}；${retryCount <= MAX_RETRIES ? "将重试" : "超过最大重试次数"}`);
    await aggregateTask(batch.taskId);
    throw error;
  }
}

async function aggregateTask(taskId: string) {
  const task = await prisma.importTask.findUnique({ where: { id: taskId } });
  if (!task) return;
  const batches = await prisma.importTaskBatch.findMany({ where: { taskId }, select: { status: true } });
  const completedBatches = batches.filter((batch) => ["COMPLETED", "FAILED"].includes(batch.status)).length;
  const done = completedBatches === batches.length;
  if (!done) { if (task.status === "PENDING") await prisma.importTask.update({ where: { id: taskId }, data: { status: "PROCESSING" } }); return; }
  const fresh = await prisma.importTask.findUniqueOrThrow({ where: { id: taskId } });
  const hasSystemFailure = batches.some((batch) => batch.status === "FAILED");
  const status = fresh.successRows > 0 && (fresh.failedRows > 0 || hasSystemFailure) ? "PARTIAL_SUCCESS" : fresh.successRows > 0 ? "COMPLETED" : "FAILED";
  await prisma.importTask.update({ where: { id: taskId }, data: { status, completedBatches, completedAt: new Date() } });
  await prisma.traceEvent.create({ data: { id: randomUUID(), taskId, traceId: fresh.traceId, eventName: status === "PARTIAL_SUCCESS" ? "ImportTaskPartialSuccess" : "ImportTaskCompleted", eventStatus: status, message: `任务完成：成功 ${fresh.successRows} 行，失败 ${fresh.failedRows} 行` } });
}

async function addTrace(task: { id: string; traceId: string }, batch: { id: string; unitId: string }, eventName: string, eventStatus: string, message: string) {
  await prisma.traceEvent.create({ data: { id: randomUUID(), taskId: task.id, batchId: batch.id, unitId: batch.unitId, traceId: task.traceId, eventName, eventStatus, message } });
}

export function errorCode(issue: { field: string; message: string }): string {
  if (issue.field === "skuCode" && issue.message.includes("不存在")) return "E001";
  if (issue.field === "qty") return "E004";
  if (issue.field === "receiverPhone") return "E003";
  if (issue.field === "externalCode") return "E005";
  if (issue.field === "row") return "E002";
  if (issue.message.includes("必填")) return "E002";
  return "E006";
}

function explain(issue: { message: string }): string {
  const messages: Record<string, string> = { "SKU 主数据不存在": "请确认 SKU 编码已在主数据中维护后重新导入" };
  return messages[issue.message] ?? issue.message;
}

export function redactRaw(field: string, value: unknown): string {
  const raw = normalizeText(value);
  if (field === "receiverPhone") return raw.length > 7 ? `${raw.slice(0, 3)}****${raw.slice(-4)}` : "***";
  if (field === "receiverAddress") return raw.length > 8 ? `${raw.slice(0, 4)}****${raw.slice(-2)}` : "***";
  return raw.slice(0, 500);
}

export function fileFingerprint(file: File): Promise<string> {
  return file.arrayBuffer().then((buffer) => createHash("sha256").update(Buffer.from(buffer)).digest("hex"));
}
