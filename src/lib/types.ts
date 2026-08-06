export type FileKind = "excel" | "word" | "pdf";

export type OrderField =
  | "externalCode"
  | "receiverShop"
  | "receiverName"
  | "receiverPhone"
  | "receiverAddress"
  | "skuCode"
  | "skuName"
  | "qty"
  | "skuSpec"
  | "remark";

export type FieldSource =
  | {
      kind: "column";
      index?: number;
      header?: string;
      fallbackHeaders?: string[];
    }
  | {
      kind: "cell";
      row: number;
      col: number;
    }
  | {
      kind: "label";
      label: string;
      offsetRows?: number;
      offsetCols?: number;
      searchFromRow?: number;
    }
  | {
      kind: "regex";
      pattern: string;
      group?: number | string;
      flags?: string;
    }
  | {
      kind: "static";
      value: string | number;
    }
  | {
      kind: "sheetName";
      pattern?: string;
      group?: number | string;
    }
  | {
      kind: "cardIndex";
      prefix?: string;
    };

export type FieldMappings = Partial<Record<OrderField, FieldSource>>;

export interface TableRuleConfig {
  headerRow: number;
  dataStartRow?: number;
  dataEndRow?: number;
  stopWhenFirstCellMatches?: string;
  skipWhenFirstCellMatches?: string;
  skipBlankRows?: boolean;
  fieldMappings: FieldMappings;
  contextMappings?: FieldMappings;
}

export interface MatrixRuleConfig {
  headerRow: number;
  dataStartRow: number;
  dataEndRow?: number;
  quantityColumnStart: number;
  quantityColumnEnd?: number;
  storeNameRow?: number;
  skuMappings: FieldMappings;
  fixedMappings?: FieldMappings;
  externalCodeTemplate?: string;
}

export interface GridRuleConfig {
  headerRow: number;
  dataStartRow: number;
  dataEndRow?: number;
  valueColumnStart: number;
  valueColumnEnd?: number;
  rowMappings?: FieldMappings;
  fixedMappings?: FieldMappings;
  itemSeparatorPattern?: string;
  itemPattern?: string;
  externalCodeTemplate?: string;
  skuCodeFallback?: "skuName" | "empty";
}

export interface CardRuleConfig {
  cardStartPattern: string;
  itemHeaderPattern: string;
  stopAtBlankRows?: number;
  infoMappings?: FieldMappings;
  itemMappings: FieldMappings;
}

export interface TextSequenceConfig {
  itemCodePattern?: string;
  minFieldsAfterCode?: number;
  contextMappings?: FieldMappings;
  itemFieldOrder?: Array<"skuCode" | "skuName" | "skuSpec" | "qty" | "remark">;
}

export interface TextRegexConfig {
  recordSeparatorPattern?: string;
  itemLinePattern?: string;
  contextMappings?: FieldMappings;
}

export interface ParseRule {
  id?: string;
  ruleName: string;
  fileType: FileKind;
  mode: "table" | "matrix" | "grid" | "cards" | "text-sequence" | "text-regex";
  sheetMode?: "first" | "all" | "named";
  sheetNames?: string[];
  table?: TableRuleConfig;
  matrix?: MatrixRuleConfig;
  grid?: GridRuleConfig;
  cards?: CardRuleConfig;
  textSequence?: TextSequenceConfig;
  textRegex?: TextRegexConfig;
  notes?: Array<{
    field?: OrderField;
    message: string;
    confidence: "high" | "medium" | "low";
  }>;
}

export interface ParsedOrder {
  id: string;
  externalCode?: string;
  receiverShop?: string;
  receiverName?: string;
  receiverPhone?: string;
  receiverAddress?: string;
  skuCode: string;
  skuName: string;
  qty: number;
  skuSpec?: string;
  remark?: string;
  sourceSheet?: string;
  sourceRow?: number;
  sourceBlock?: string;
}

export interface ParsedOrderGroup {
  groupKey: string;
  externalCode?: string;
  receiverShop?: string;
  receiverName?: string;
  receiverPhone?: string;
  receiverAddress?: string;
  rows: ParsedOrder[];
  rowIndexes: number[];
  skuLineCount: number;
  totalQty: number;
  hasReceiverConflict: boolean;
}

export interface ValidationIssue {
  rowIndex: number;
  field: OrderField | "row";
  message: string;
  severity: "error" | "warning";
}

export interface SheetSnapshot {
  name: string;
  rows: string[][];
  rowCount: number;
  colCount: number;
}

export interface FileStructure {
  fileName: string;
  fileType: FileKind;
  sheets?: SheetSnapshot[];
  text?: string;
  pages?: Array<{
    page: number;
    text: string;
  }>;
}

export const ORDER_FIELDS: Array<{ key: OrderField; label: string; required?: boolean }> = [
  { key: "externalCode", label: "外部编码" },
  { key: "receiverShop", label: "收货门店" },
  { key: "receiverName", label: "收件人姓名" },
  { key: "receiverPhone", label: "收件人电话" },
  { key: "receiverAddress", label: "收件人地址" },
  { key: "skuCode", label: "SKU物品编码", required: true },
  { key: "skuName", label: "SKU物品名称", required: true },
  { key: "qty", label: "SKU发货数量", required: true },
  { key: "skuSpec", label: "SKU规格型号" },
  { key: "remark", label: "备注" },
];

export function getFileKind(fileName: string): FileKind | null {
  const suffix = fileName.split(".").pop()?.toLowerCase();
  if (suffix === "xlsx" || suffix === "xls") return "excel";
  if (suffix === "docx") return "word";
  if (suffix === "pdf") return "pdf";
  return null;
}

export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

export function toPositiveNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = normalizeText(value).replace(/,/g, "");
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return 0;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function validateOrders(
  rows: ParsedOrder[],
  existingExternalCodes: Iterable<string> = [],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const existing = new Set(Array.from(existingExternalCodes).filter(Boolean));
  const firstSeen = new Map<string, { rowIndex: number; receiverSignature: string }>();

  rows.forEach((row, rowIndex) => {
    const line = rowIndex + 1;
    if (!normalizeText(row.skuCode)) {
      issues.push({ rowIndex, field: "skuCode", message: `第 ${line} 行 SKU物品编码必填`, severity: "error" });
    }
    if (!normalizeText(row.skuName)) {
      issues.push({ rowIndex, field: "skuName", message: `第 ${line} 行 SKU物品名称必填`, severity: "error" });
    }
    if (!toPositiveNumber(row.qty)) {
      issues.push({ rowIndex, field: "qty", message: `第 ${line} 行 SKU发货数量必须为正数`, severity: "error" });
    }

    const hasStoreMode = Boolean(normalizeText(row.receiverShop));
    const hasReceiverMode =
      Boolean(normalizeText(row.receiverName)) &&
      Boolean(normalizeText(row.receiverPhone)) &&
      Boolean(normalizeText(row.receiverAddress));

    if (!hasStoreMode && !hasReceiverMode) {
      issues.push({
        rowIndex,
        field: "row",
        message: `第 ${line} 行需填写收货门店，或完整填写收件人姓名/电话/地址`,
        severity: "error",
      });
    }

    const phone = normalizeText(row.receiverPhone);
    if (phone && !/^(\+?\d[\d -]{6,20}|\d{11})$/.test(phone)) {
      issues.push({ rowIndex, field: "receiverPhone", message: `第 ${line} 行电话格式不正确`, severity: "error" });
    }

    const code = normalizeText(row.externalCode);
    if (code) {
      if (existing.has(code)) {
        issues.push({ rowIndex, field: "externalCode", message: `第 ${line} 行外部编码与历史数据重复`, severity: "error" });
      }
      const prior = firstSeen.get(code);
      const receiverSignature = getReceiverSignature(row);
      if (prior !== undefined && prior.receiverSignature !== receiverSignature) {
        issues.push({
          rowIndex,
          field: "externalCode",
          message: `第 ${line} 行外部编码与第 ${prior.rowIndex + 1} 行重复，但收货信息不一致`,
          severity: "error",
        });
      } else if (prior !== undefined) {
        issues.push({
          rowIndex,
          field: "externalCode",
          message: `第 ${line} 行与第 ${prior.rowIndex + 1} 行属于同一外部编码出库单，已按出库单聚合展示`,
          severity: "warning",
        });
      } else if (prior === undefined) {
        firstSeen.set(code, { rowIndex, receiverSignature });
      }
    }
  });

  return issues;
}

export function aggregateOrders(rows: ParsedOrder[]): ParsedOrderGroup[] {
  const groups = new Map<string, ParsedOrderGroup>();

  rows.forEach((row, rowIndex) => {
    const externalCode = normalizeText(row.externalCode);
    const receiverSignature = getReceiverSignature(row);
    const groupKey = externalCode || `${receiverSignature || "row"}-${rowIndex + 1}`;
    const existing = groups.get(groupKey);

    if (!existing) {
      groups.set(groupKey, {
        groupKey,
        externalCode,
        receiverShop: normalizeText(row.receiverShop),
        receiverName: normalizeText(row.receiverName),
        receiverPhone: normalizeText(row.receiverPhone),
        receiverAddress: normalizeText(row.receiverAddress),
        rows: [row],
        rowIndexes: [rowIndex],
        skuLineCount: 1,
        totalQty: toPositiveNumber(row.qty),
        hasReceiverConflict: false,
      });
      return;
    }

    existing.rows.push(row);
    existing.rowIndexes.push(rowIndex);
    existing.skuLineCount += 1;
    existing.totalQty += toPositiveNumber(row.qty);
    existing.hasReceiverConflict ||= getReceiverSignature(existing.rows[0]) !== receiverSignature;
  });

  return Array.from(groups.values());
}

function getReceiverSignature(row: ParsedOrder): string {
  return [
    normalizeText(row.receiverShop),
    normalizeText(row.receiverName),
    normalizeText(row.receiverPhone),
    normalizeText(row.receiverAddress),
  ].join("|");
}
