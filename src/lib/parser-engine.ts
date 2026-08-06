import mammoth from "mammoth";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as XLSX from "xlsx";
import type {
  CardRuleConfig,
  FieldMappings,
  FieldSource,
  FileKind,
  FileStructure,
  GridRuleConfig,
  MatrixRuleConfig,
  OrderField,
  ParsedOrder,
  ParseRule,
  SheetSnapshot,
  TableRuleConfig,
  TextSequenceConfig,
} from "./types";
import { getFileKind, normalizeText, toPositiveNumber } from "./types";

type CellGrid = string[][];

interface ParseContext {
  sheetName?: string;
  rows?: CellGrid;
  text?: string;
  row?: string[];
  rowIndex?: number;
  headers?: string[];
  cardRows?: CellGrid;
  cardIndex?: number;
}

const FIELD_DEFAULTS: Record<OrderField, string | number> = {
  externalCode: "",
  receiverShop: "",
  receiverName: "",
  receiverPhone: "",
  receiverAddress: "",
  skuCode: "",
  skuName: "",
  qty: 0,
  skuSpec: "",
  remark: "",
};

export class ParserEngine {
  static async extractStructure(file: File): Promise<FileStructure> {
    const fileType = getFileKind(file.name);
    if (!fileType) {
      throw new Error("仅支持 .xlsx/.xls/.docx/.pdf 文件");
    }

    if (fileType === "excel") {
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array", cellDates: false, raw: false });
      const sheets: SheetSnapshot[] = workbook.SheetNames.map((name) => {
        const worksheet = workbook.Sheets[name];
        const range = worksheet["!ref"] ? XLSX.utils.decode_range(worksheet["!ref"]) : null;
        const rows = XLSX.utils.sheet_to_json<string[]>(worksheet, {
          header: 1,
          raw: false,
          defval: "",
          blankrows: true,
        });
        const normalizedRows = rows.map((row) => row.map((cell) => normalizeCell(cell)));
        return {
          name,
          rows: trimGrid(fillMergedCells(worksheet, normalizedRows)),
          rowCount: range ? range.e.r + 1 : rows.length,
          colCount: range ? range.e.c + 1 : Math.max(0, ...rows.map((row) => row.length)),
        };
      });
      return { fileName: file.name, fileType, sheets };
    }

    if (fileType === "word") {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      return { fileName: file.name, fileType, text: result.value };
    }

    const text = await extractPdfText(file);
    return { fileName: file.name, fileType, text, pages: [{ page: 1, text }] };
  }

  static async generateLocalRule(structure: FileStructure): Promise<ParseRule> {
    if (structure.fileType === "excel") {
      return buildExcelRule(structure);
    }

    const text = structure.text ?? "";
    return buildTextRule(structure.fileType, text);
  }

  static async parse(file: File, rule: ParseRule): Promise<ParsedOrder[]> {
    const structure = await this.extractStructure(file);
    return this.parseStructure(structure, rule);
  }

  static parseStructure(structure: FileStructure, rule: ParseRule): ParsedOrder[] {
    if (isSheetRule(rule)) {
      const sheets = selectSheets(structureToSheets(structure), rule);
      const parsed = sheets.flatMap((sheet) => parseSheet(sheet, rule));
      return withStableIds(parsed);
    }

    const text = structureToText(structure);
    const parsed =
      rule.mode === "text-regex"
        ? parseTextRegex(text, rule, structure.fileType)
        : parseTextSequence(text, rule.textSequence, structure.fileType);
    return withStableIds(parsed);
  }
}

function parseSheet(sheet: SheetSnapshot, rule: ParseRule): ParsedOrder[] {
  if (rule.mode === "matrix" && rule.matrix) {
    return parseMatrix(sheet, rule.matrix);
  }
  if (rule.mode === "grid" && rule.grid) {
    return parseGrid(sheet, rule.grid);
  }
  if (rule.mode === "cards" && rule.cards) {
    return parseCards(sheet, rule.cards);
  }
  if (rule.mode === "table" && rule.table) {
    return parseTable(sheet, rule.table);
  }
  return [];
}

function parseTable(sheet: SheetSnapshot, config: TableRuleConfig): ParsedOrder[] {
  const rows = sheet.rows;
  const headerRow = config.headerRow;
  const headers = rows[headerRow] ?? [];
  const start = config.dataStartRow ?? headerRow + 1;
  const end = Math.min(config.dataEndRow ?? rows.length - 1, rows.length - 1);
  const context = resolveMappings(config.contextMappings ?? {}, { rows, headers, sheetName: sheet.name, text: flattenRows(rows) });
  const orders: ParsedOrder[] = [];

  for (let rowIndex = start; rowIndex <= end; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const firstCell = normalizeText(row[0]);
    if (config.skipBlankRows !== false && row.every((cell) => !normalizeText(cell))) continue;
    if (config.stopWhenFirstCellMatches && createRuleRegex(config.stopWhenFirstCellMatches).test(firstCell)) break;
    if (config.skipWhenFirstCellMatches && createRuleRegex(config.skipWhenFirstCellMatches).test(firstCell)) continue;

    const mapped = {
      ...context,
      ...resolveMappings(config.fieldMappings, {
        rows,
        row,
        rowIndex,
        headers,
        sheetName: sheet.name,
        text: flattenRows(rows),
      }),
    };

    if (!hasAnySkuSignal(mapped)) continue;
    orders.push(toOrder(mapped, sheet.name, rowIndex + 1));
  }

  return orders;
}

function parseMatrix(sheet: SheetSnapshot, config: MatrixRuleConfig): ParsedOrder[] {
  const rows = sheet.rows;
  const headerRow = rows[config.headerRow] ?? [];
  const storeRow = rows[config.storeNameRow ?? config.headerRow] ?? headerRow;
  const lastQtyCol = config.quantityColumnEnd ?? headerRow.length - 1;
  const orders: ParsedOrder[] = [];

  for (let rowIndex = config.dataStartRow; rowIndex <= (config.dataEndRow ?? rows.length - 1); rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    if (row.every((cell) => !normalizeText(cell))) continue;
    const skuData = resolveMappings(config.skuMappings, {
      rows,
      row,
      rowIndex,
      headers: headerRow,
      sheetName: sheet.name,
      text: flattenRows(rows),
    });

    for (let col = config.quantityColumnStart; col <= lastQtyCol; col += 1) {
      const qty = toPositiveNumber(row[col]);
      if (qty <= 0) continue;
      const storeName = normalizeText(storeRow[col] || headerRow[col]);
      const templateExternalCode = renderTemplate(config.externalCodeTemplate, {
        sheetName: sheet.name,
        rowIndex,
        col,
        columnLabel: storeName,
        receiverShop: storeName,
      });
      const mapped = {
        ...resolveMappings(config.fixedMappings ?? {}, {
          rows,
          row,
          rowIndex,
          headers: headerRow,
          sheetName: sheet.name,
          text: flattenRows(rows),
        }),
        ...skuData,
        externalCode: templateExternalCode || skuData.externalCode,
        receiverShop: storeName,
        qty,
      };
      orders.push(toOrder(mapped, sheet.name, rowIndex + 1, storeName));
    }
  }

  return orders;
}

function parseGrid(sheet: SheetSnapshot, config: GridRuleConfig): ParsedOrder[] {
  const rows = sheet.rows;
  const headers = rows[config.headerRow] ?? [];
  const lastValueCol = config.valueColumnEnd ?? headers.length - 1;
  const separator = createRuleRegex(config.itemSeparatorPattern ?? "[\\n；;]+");
  const itemPattern = createRuleRegex(config.itemPattern ?? "^(.+?)(?:\\s*[xX×*]\\s*|[:：]\\s*|\\s+)(\\d+(?:\\.\\d+)?)$");
  const orders: ParsedOrder[] = [];

  for (let rowIndex = config.dataStartRow; rowIndex <= (config.dataEndRow ?? rows.length - 1); rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    if (row.every((cell) => !normalizeText(cell))) continue;
    const rowData = resolveMappings(config.rowMappings ?? {}, {
      rows,
      row,
      rowIndex,
      headers,
      sheetName: sheet.name,
      text: flattenRows(rows),
    });
    const fixedData = resolveMappings(config.fixedMappings ?? {}, {
      rows,
      row,
      rowIndex,
      headers,
      sheetName: sheet.name,
      text: flattenRows(rows),
    });

    for (let col = config.valueColumnStart; col <= lastValueCol; col += 1) {
      const cell = normalizeCell(row[col]);
      if (!cell) continue;
      const columnLabel = normalizeText(headers[col]) || `列${col + 1}`;
      const parts = cell
        .split(separator)
        .map((part) => normalizeText(part))
        .filter(Boolean);

      parts.forEach((part, partIndex) => {
        const match = part.match(itemPattern);
        const skuName = normalizeText(match?.[1] ?? part.replace(/(?:\d+(?:\.\d+)?)$/, ""));
        const qty = toPositiveNumber(match?.[2] ?? part);
        if (!skuName || qty <= 0) return;
        const externalCode = renderTemplate(config.externalCodeTemplate, {
          sheetName: sheet.name,
          rowIndex,
          col,
          columnLabel,
          itemIndex: partIndex,
          receiverShop: normalizeText(rowData.receiverShop),
        });
        const mapped = {
          ...fixedData,
          ...rowData,
          externalCode: externalCode || fixedData.externalCode || rowData.externalCode || `${sheet.name}-${rowIndex + 1}-${col + 1}`,
          skuCode: config.skuCodeFallback === "empty" ? "" : skuName,
          skuName,
          qty,
          remark: normalizeText(fixedData.remark || rowData.remark || columnLabel),
        };
        orders.push(toOrder(mapped, sheet.name, rowIndex + 1, columnLabel));
      });
    }
  }

  return orders;
}

function parseCards(sheet: SheetSnapshot, config: CardRuleConfig): ParsedOrder[] {
  const blocks = splitCards(sheet.rows, config.cardStartPattern);
  const orders: ParsedOrder[] = [];

  blocks.forEach((block, cardIndex) => {
    const cardText = flattenRows(block.rows);
    const info = resolveMappings(config.infoMappings ?? {}, {
      rows: block.rows,
      cardRows: block.rows,
      sheetName: sheet.name,
      text: cardText,
      cardIndex,
    });
    const itemHeaderRegex = createRuleRegex(config.itemHeaderPattern);
    const headerIndex = block.rows.findIndex((row) => row.some((cell) => itemHeaderRegex.test(cell)));
    if (headerIndex < 0) return;
    const headers = block.rows[headerIndex] ?? [];
    let blankCount = 0;
    for (let i = headerIndex + 1; i < block.rows.length; i += 1) {
      const row = block.rows[i] ?? [];
      if (row.every((cell) => !normalizeText(cell))) {
        blankCount += 1;
        if (blankCount >= (config.stopAtBlankRows ?? 1)) break;
        continue;
      }
      blankCount = 0;
      const mapped = {
        ...info,
        ...resolveMappings(config.itemMappings, {
          rows: block.rows,
          row,
          rowIndex: i,
          headers,
          sheetName: sheet.name,
          text: cardText,
          cardIndex,
        }),
      };
      if (!hasAnySkuSignal(mapped)) continue;
      orders.push(toOrder(mapped, sheet.name, block.startRow + i + 1, `卡片 ${cardIndex + 1}`));
    }
  });

  return orders;
}

function parseTextSequence(text: string, config: TextSequenceConfig | undefined, fileType: FileKind): ParsedOrder[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const fullText = lines.join("\n");
  const itemCodePattern = config?.itemCodePattern ?? "^[A-Z0-9][A-Z0-9_-]{4,}$";
  const codeRegex = createRuleRegex(itemCodePattern);
  const context = resolveMappings(config?.contextMappings ?? defaultTextContextMappings(), { text: fullText });
  const order: Array<"skuCode" | "skuName" | "skuSpec" | "qty" | "remark"> =
    config?.itemFieldOrder ?? ["skuCode", "skuName", "skuSpec", "remark", "qty"];
  const rows: ParsedOrder[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!codeRegex.test(lines[i])) continue;
    const values: Partial<Record<OrderField, string | number>> = {};
    let cursor = i;
    for (const field of order) {
      if (field === "skuCode") {
        values.skuCode = lines[i];
        continue;
      }
      cursor += 1;
      if (cursor >= lines.length) break;
      values[field] = lines[cursor];
    }
    const qtyCandidate = findNearestQuantity(lines, i + 1, i + 8);
    values.qty = qtyCandidate || values.qty || 0;
    const mapped = { ...context, ...values };
    if (hasAnySkuSignal(mapped)) rows.push(toOrder(mapped, undefined, i + 1, fileType));
  }

  return rows;
}

function parseTextRegex(text: string, rule: ParseRule, fileType: FileKind): ParsedOrder[] {
  const config = rule.textRegex;
  if (!config?.itemLinePattern) return parseTextSequence(text, rule.textSequence, fileType);
  const itemLinePattern = config.itemLinePattern;
  const blocks = config.recordSeparatorPattern
    ? text.split(createRuleRegex(config.recordSeparatorPattern, "m"))
    : [text];
  const rows: ParsedOrder[] = [];

  blocks.forEach((block, blockIndex) => {
    const context = resolveMappings(config.contextMappings ?? defaultTextContextMappings(), { text: block });
    const itemRegex = createRuleRegex(itemLinePattern, "gm");
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(block))) {
      const mapped = {
        ...context,
        skuCode: match.groups?.skuCode ?? match[1] ?? "",
        skuName: match.groups?.skuName ?? match[2] ?? "",
        skuSpec: match.groups?.skuSpec ?? match[3] ?? "",
        qty: match.groups?.qty ?? match[4] ?? "",
      };
      rows.push(toOrder(mapped, undefined, blockIndex + 1, "文本记录"));
    }
  });

  return rows;
}

function isSheetRule(rule: ParseRule): boolean {
  return rule.mode === "table" || rule.mode === "matrix" || rule.mode === "grid" || rule.mode === "cards";
}

function structureToText(structure: FileStructure): string {
  if (structure.text) return structure.text;
  if (structure.pages?.length) return structure.pages.map((page) => page.text).join("\n");
  return (structure.sheets ?? [])
    .map((sheet) => {
      const cellLines = sheet.rows
        .flatMap((row) => row.map((cell) => normalizeText(cell)).filter(Boolean))
        .join("\n");
      return [`【${sheet.name}】`, flattenRows(sheet.rows), cellLines].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n");
}

function structureToSheets(structure: FileStructure): SheetSnapshot[] {
  if (structure.sheets?.length) return structure.sheets;

  const text = structureToText(structure);
  const rows = text
    .split(/\r?\n/)
    .map(textLineToRow)
    .filter((row) => row.some((cell) => normalizeText(cell)));

  if (!rows.length) return [];

  return [
    {
      name: "文本结构",
      rows,
      rowCount: rows.length,
      colCount: Math.max(0, ...rows.map((row) => row.length)),
    },
  ];
}

function textLineToRow(line: string): string[] {
  const normalized = normalizeCell(line);
  if (!normalized) return [];
  if (normalized.includes("\t")) return normalized.split("\t").map((cell) => normalizeText(cell));

  const separated = normalized
    .split(/\s{2,}|[|｜]/)
    .map((cell) => normalizeText(cell))
    .filter(Boolean);
  return separated.length > 1 ? separated : [normalized];
}

function buildExcelRule(structure: FileStructure): ParseRule {
  const sheets = structure.sheets ?? [];
  const first = sheets[0];
  if (!first) {
    throw new Error("Excel 文件为空，无法生成规则");
  }

  const cardPattern = "^(▶|>|#)?\\s*(调拨记录|配送单|记录)\\s*#?\\d+";
  const cardRegex = createRuleRegex(cardPattern);
  if (sheets.some((sheet) => sheet.rows.some((row) => row.some((cell) => cardRegex.test(cell))))) {
    return {
      ruleName: "AI推荐-卡片式规则",
      fileType: "excel",
      mode: "cards",
      sheetMode: "all",
      cards: {
        cardStartPattern: cardPattern,
        itemHeaderPattern: "物品编码|SKU|商品编码",
        infoMappings: {
          receiverShop: { kind: "label", label: "调入门店", offsetCols: 1 },
          receiverName: { kind: "label", label: "收货人", offsetCols: 1 },
          receiverPhone: { kind: "label", label: "电话", offsetCols: 1 },
          receiverAddress: { kind: "label", label: "收货地址", offsetCols: 1 },
          externalCode: { kind: "cardIndex", prefix: "CARD" },
        },
        itemMappings: {
          skuCode: { kind: "column", header: "物品编码" },
          skuName: { kind: "column", header: "物品名称" },
          skuSpec: { kind: "column", header: "规格" },
          qty: { kind: "column", header: "数量" },
        },
      },
      notes: [{ message: "检测到卡片起始行，已生成卡片式拆分规则。", confidence: "high" }],
    };
  }

  const detected = detectHeader(first.rows);
  const headers = first.rows[detected.headerRow] ?? [];
  const gridRange = detectCompositeGridRange(first.rows, detected.headerRow);
  if (gridRange) {
    return {
      ruleName: "AI推荐-复合单元格网格规则",
      fileType: "excel",
      mode: "grid",
      sheetMode: "first",
      grid: {
        headerRow: detected.headerRow,
        dataStartRow: detected.headerRow + 1,
        valueColumnStart: gridRange.start,
        valueColumnEnd: gridRange.end,
        rowMappings: {
          receiverShop: byHeader(headers, ["收货门店", "门店", "收货机构", "店名"], 0),
          receiverName: byHeader(headers, ["收货人", "联系人"]),
          receiverPhone: byHeader(headers, ["电话", "联系电话", "收货电话"]),
          receiverAddress: byHeader(headers, ["地址", "收货地址"]),
        },
        itemSeparatorPattern: "[\\n；;]+",
        itemPattern: "^(.+?)(?:\\s*[xX×*]\\s*|[:：]\\s*|\\s+)(\\d+(?:\\.\\d+)?)$",
        externalCodeTemplate: "{{sheetName}}-{{rowIndex}}-{{columnLabel}}-{{itemIndex}}",
        skuCodeFallback: "skuName",
      },
      notes: [{ message: "检测到行列网格内含多条物品和数量，已生成复合单元格拆分规则。", confidence: "high" }],
    };
  }
  const matrixRange = detectMatrixRange(first.rows, detected.headerRow);
  if (matrixRange) {
    return {
      ruleName: "AI推荐-矩阵转置规则",
      fileType: "excel",
      mode: "matrix",
      sheetMode: "first",
      matrix: {
        headerRow: detected.headerRow,
        dataStartRow: detected.headerRow + 1,
        quantityColumnStart: matrixRange.start,
        quantityColumnEnd: matrixRange.end,
        skuMappings: {
          skuCode: byHeader(headers, ["外部商品编码", "SKU条码", "物品编码", "商品编码"], 4),
          skuName: byHeader(headers, ["SKU名称", "物品名称", "商品名称"], 2),
          skuSpec: byHeader(headers, ["规格", "规格型号"], 7),
        },
        externalCodeTemplate: "{{sheetName}}-{{columnLabel}}",
      },
      notes: [{ message: "检测到门店列横向展开，已生成矩阵转置规则。", confidence: "high" }],
    };
  }

  const allSheetsSameShape = sheets.length > 1 && sheets.every((sheet) => detectHeader(sheet.rows).score >= 3);
  const headerRow = detected.headerRow;
  const contextMappings = inferContextMappings();
  return {
    ruleName: allSheetsSameShape ? "AI推荐-多Sheet表格规则" : "AI推荐-标准表格规则",
    fileType: "excel",
    mode: "table",
    sheetMode: allSheetsSameShape ? "all" : "first",
    table: {
      headerRow,
      dataStartRow: headerRow + 1,
      stopWhenFirstCellMatches: "^(合计|总计|小计)",
      skipWhenFirstCellMatches: "^(合计|总计|小计)",
      fieldMappings: {
        externalCode: byHeader(headers, ["配送单号", "单据号", "配送汇总单号", "外部编码", "订单号"]),
        receiverShop: byHeader(headers, ["收货机构", "收货门店", "门店"], undefined, contextMappings.receiverShop),
        receiverName: byHeader(headers, ["收货人", "收件人姓名", "联系人"], undefined, contextMappings.receiverName),
        receiverPhone: byHeader(headers, ["收货电话", "联系电话", "收件人电话", "电话"], undefined, contextMappings.receiverPhone),
        receiverAddress: byHeader(headers, ["收货地址", "收件人地址", "地址"], undefined, contextMappings.receiverAddress),
        skuCode: byHeader(headers, ["SKU物品编码", "SKU编码", "物品编码", "商品编码"]),
        skuName: byHeader(headers, ["SKU物品名称", "SKU名称", "物品名称", "商品名称"]),
        qty: byHeader(headers, ["SKU发货数量", "发货数量", "出库数量", "实发数量", "数量"]),
        skuSpec: byHeader(headers, ["规格型号", "规格"]),
        remark: byHeader(headers, ["备注", "物品备注", "单据备注"]),
      },
      contextMappings,
    },
    notes: [
      { message: `推测第 ${headerRow + 1} 行为表头，第 ${headerRow + 2} 行开始为数据。`, confidence: detected.score >= 3 ? "high" : "medium" },
      { message: "请重点确认 SKU 编码、名称、数量三列和收货信息位置。", confidence: "medium" },
    ],
  };
}

function buildTextRule(fileType: FileKind, text: string): ParseRule {
  return {
    ruleName: fileType === "pdf" ? "AI推荐-PDF文本序列规则" : "AI推荐-Word文本规则",
    fileType,
    mode: "text-sequence",
    textSequence: {
      itemCodePattern: "^[A-Z0-9][A-Z0-9_-]{4,}$",
      contextMappings: defaultTextContextMappings(),
      itemFieldOrder: ["skuCode", "skuName", "skuSpec", "qty"],
    },
    notes: [
      { message: "文本类文件先提取全文，再按 SKU 编码附近的连续文本生成明细行。", confidence: "medium" },
      { message: text.includes("收货地址") ? "已检测到收货地址文本，可通过正则抽取。 " : "未明显检测到收货地址，请人工确认。", confidence: "medium" },
    ],
  };
}

function detectHeader(rows: CellGrid): { headerRow: number; score: number } {
  const keywords = [
    "物品编码",
    "物品名称",
    "SKU",
    "商品编码",
    "商品名称",
    "发货数量",
    "出库数量",
    "数量",
    "规格",
    "收货",
    "门店",
    "店名",
    "周一",
    "周二",
    "周三",
    "周四",
    "周五",
    "星期",
  ];
  let best = { headerRow: 0, score: -1 };
  rows.slice(0, 20).forEach((row, index) => {
    const text = row.join(" ");
    const gridHeaderScore = row.filter((cell) => looksLikeGridHeader(normalizeText(cell))).length;
    const score = keywords.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0) + gridHeaderScore;
    if (score > best.score) best = { headerRow: index, score };
  });
  return best;
}

function detectMatrixRange(rows: CellGrid, headerRowIndex: number): { start: number; end: number } | null {
  const headers = rows[headerRowIndex] ?? [];
  const fixedLabels = new Set([
    "序号",
    "仓库名称",
    "仓库",
    "货主名称",
    "SKU名称",
    "SKU条码",
    "外部商品编码",
    "物品编码",
    "物品名称",
    "商品编码",
    "商品名称",
    "物品分类",
    "物品品牌",
    "库存状态",
    "库存单位",
    "单位",
    "规格",
    "规格型号",
    "订货单位",
    "订货单位和基准单位换算率",
    "原订货数量",
    "订货数量",
    "接单数量",
    "应发数量",
    "发货数量",
    "出库数量",
    "在库数量的总和",
    "可用数量的总和",
    "待移入数的总和",
    "分配数量的总和",
    "冻结数量的总和",
    "下单后结余",
    "备注",
  ]);

  const hasSkuIdentity = headers.some((header) => /SKU|物品编码|商品编码|条码/.test(normalizeText(header))) &&
    headers.some((header) => /SKU名称|物品名称|商品名称/.test(normalizeText(header)));
  if (!hasSkuIdentity) return null;

  const candidateIndexes: number[] = [];
  for (let i = 0; i < headers.length; i += 1) {
    const header = normalizeText(headers[i]);
    if (!header) continue;
    if (!fixedLabels.has(header) && looksLikeMatrixQuantityHeader(header)) {
      candidateIndexes.push(i);
    }
  }

  const groups: Array<{ start: number; end: number; count: number }> = [];
  for (const index of candidateIndexes) {
    const current = groups[groups.length - 1];
    if (current && index === current.end + 1) {
      current.end = index;
      current.count += 1;
    } else {
      groups.push({ start: index, end: index, count: 1 });
    }
  }

  const sampleRows = rows.slice(headerRowIndex + 1, headerRowIndex + 31);
  const viableGroups = groups
    .filter((group) => group.count >= 2)
    .map((group) => {
      const numericSignals = sampleRows.reduce((sum, row) => {
        for (let col = group.start; col <= group.end; col += 1) {
          if (toPositiveNumber(row[col]) > 0) return sum + 1;
        }
        return sum;
      }, 0);
      return { ...group, numericSignals };
    })
    .filter((group) => group.numericSignals > 0)
    .sort((a, b) => b.count - a.count || b.numericSignals - a.numericSignals);

  const best = viableGroups[0];
  return best ? { start: best.start, end: best.end } : null;
}

function detectCompositeGridRange(rows: CellGrid, headerRowIndex: number): { start: number; end: number } | null {
  const headers = rows[headerRowIndex] ?? [];
  const candidateIndexes = headers.reduce<number[]>((indexes, header, index) => {
    if (looksLikeGridHeader(normalizeText(header))) indexes.push(index);
    return indexes;
  }, []);
  if (candidateIndexes.length < 2) return null;

  const groups = groupConsecutive(candidateIndexes);
  const sampleRows = rows.slice(headerRowIndex + 1, headerRowIndex + 31);
  const viableGroups = groups
    .map((group) => {
      const compositeSignals = sampleRows.reduce((sum, row) => {
        for (let col = group.start; col <= group.end; col += 1) {
          const cell = normalizeText(row[col]);
          if (/[xX×*]\s*\d+|\d+(?:\.\d+)?/.test(cell) && /[\u4e00-\u9fa5A-Za-z]/.test(cell)) return sum + 1;
        }
        return sum;
      }, 0);
      return { ...group, compositeSignals };
    })
    .filter((group) => group.count >= 2 && group.compositeSignals > 0)
    .sort((a, b) => b.compositeSignals - a.compositeSignals || b.count - a.count);

  const best = viableGroups[0];
  return best ? { start: best.start, end: best.end } : null;
}

function looksLikeMatrixQuantityHeader(header: string): boolean {
  if (/^(周[一二三四五六日]|星期[一二三四五六日]|\d{1,2}[/-]\d{1,2}|\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}月\d{1,2}日)$/.test(header)) {
    return true;
  }

  return !/(编码|名称|数量|库存|规格|状态|货主|仓库|单位|结余|条码|分类|品牌|备注|日期|时间|收货|联系|电话|地址|单号|行号|序号|发货|到货|期望|生产|批次|辅助|基准|复审|创建|操作|单价|金额|重量|体积|折扣|成本|支付|促销|分拣|存储|方式)/.test(header);
}

function looksLikeGridHeader(header: string): boolean {
  if (!header) return false;
  return /^(周[一二三四五六日]|星期[一二三四五六日]|\d{1,2}[/-]\d{1,2}|\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}月\d{1,2}日)$/.test(header);
}

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((part) => part.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .trim();
}

function inferContextMappings(): FieldMappings {
  return {
    receiverShop: { kind: "label", label: "收货门店|收货机构", offsetCols: 1 },
    receiverName: { kind: "label", label: "收货人|联系人", offsetCols: 1 },
    receiverPhone: { kind: "label", label: "收货电话|联系电话", offsetCols: 1 },
    receiverAddress: { kind: "label", label: "收货地址", offsetCols: 1 },
    externalCode: { kind: "label", label: "单据号|配送单号", offsetCols: 1 },
  };
}

function defaultTextContextMappings(): FieldMappings {
  return {
    externalCode: { kind: "regex", pattern: "(?:单据编号|单据号|配送单号)[:：]\\s*([^\\s]+)", group: 1 },
    receiverShop: { kind: "regex", pattern: "(?:收货机构|收货门店)[:：]\\s*([^\\n]+)", group: 1 },
    receiverName: { kind: "regex", pattern: "收货人[:：]\\s*([^\\n\\s]+)", group: 1 },
    receiverPhone: { kind: "regex", pattern: "收货电话[:：]\\s*([^\\n\\s]+)", group: 1 },
    receiverAddress: { kind: "regex", pattern: "收货地址[:：]\\s*([^\\n]+)", group: 1 },
  };
}

function byHeader(
  headers: string[],
  candidates: string[],
  fallbackIndex?: number,
  fallback?: FieldSource,
): FieldSource {
  const index = findBestHeaderIndex(headers, candidates);
  if (index >= 0) return { kind: "column", index, header: headers[index], fallbackHeaders: candidates };
  if (fallback) return fallback;
  if (fallbackIndex !== undefined) return { kind: "column", index: fallbackIndex, fallbackHeaders: candidates };
  return { kind: "column", fallbackHeaders: candidates };
}

function resolveMappings(mappings: FieldMappings, context: ParseContext): Partial<Record<OrderField, string | number>> {
  const result: Partial<Record<OrderField, string | number>> = {};
  for (const [field, source] of Object.entries(mappings) as Array<[OrderField, FieldSource | undefined]>) {
    if (!source) continue;
    const value = resolveSource(source, context);
    if (value !== "") result[field] = value;
  }
  return result;
}

function resolveSource(source: FieldSource, context: ParseContext): string | number {
  if (source.kind === "static") return source.value;
  if (source.kind === "sheetName") {
    const sheetName = context.sheetName ?? "";
    if (!source.pattern) return sheetName;
    const match = sheetName.match(createRuleRegex(source.pattern));
    return pickRegexGroup(match, source.group);
  }
  if (source.kind === "cardIndex") {
    return `${source.prefix ?? "CARD"}-${(context.cardIndex ?? 0) + 1}`;
  }
  if (source.kind === "cell") {
    return normalizeText(context.rows?.[source.row]?.[source.col]);
  }
  if (source.kind === "column") {
    const col = source.index ?? findHeaderIndex(context.headers ?? [], source.header, source.fallbackHeaders);
    if (col === undefined || col < 0) return "";
    return normalizeText(context.row?.[col]);
  }
  if (source.kind === "label") {
    return findByLabel(context.rows ?? context.cardRows ?? [], source);
  }
  if (source.kind === "regex") {
    const flags = source.flags ?? "m";
    const match = (context.text ?? "").match(createRuleRegex(source.pattern, flags));
    return pickRegexGroup(match, source.group);
  }
  return "";
}

function findHeaderIndex(headers: string[], header?: string, fallbacks?: string[]): number | undefined {
  const candidates = [header, ...(fallbacks ?? [])].filter(Boolean).map((value) => normalizeText(value));
  if (!candidates.length) return undefined;
  return findBestHeaderIndex(headers, candidates);
}

function findBestHeaderIndex(headers: string[], candidates: string[]): number {
  const normalizedHeaders = headers.map((item) => normalizeText(item));

  for (const candidate of candidates.map((item) => normalizeText(item)).filter(Boolean)) {
    const exact = normalizedHeaders.findIndex((header) => header === candidate);
    if (exact >= 0) return exact;
  }

  for (const candidate of candidates.map((item) => normalizeText(item)).filter(Boolean)) {
    const contains = normalizedHeaders.findIndex((header) => header.includes(candidate));
    if (contains >= 0) return contains;
  }

  return -1;
}

function findByLabel(rows: CellGrid, source: Extract<FieldSource, { kind: "label" }>): string {
  const offsetRows = source.offsetRows ?? 0;
  const offsetCols = source.offsetCols ?? 1;
  for (let r = source.searchFromRow ?? 0; r < rows.length; r += 1) {
    for (let c = 0; c < (rows[r]?.length ?? 0); c += 1) {
      const cell = normalizeText(rows[r][c]);
      const inlineValue = getInlineLabelValue(cell, source.label);
      if (inlineValue === null) continue;

      if (inlineValue) return inlineValue;

      const targetRow = rows[r + offsetRows] ?? [];
      const direct = normalizeText(targetRow[c + offsetCols]);
      if (direct) return direct;

      for (let nextCol = c + 1; nextCol < targetRow.length; nextCol += 1) {
        const next = normalizeText(targetRow[nextCol]);
        if (next) return next;
      }
    }
  }
  return "";
}

function getInlineLabelValue(cell: string, labelPattern: string): string | null {
  const exact = createRuleRegex(`^(?:${labelPattern})\\s*[:：]?\\s*$`);
  if (exact.test(cell)) return "";

  const inline = cell.match(createRuleRegex(`^(?:${labelPattern})\\s*[:：]\\s*(.+)$`));
  return inline ? normalizeText(inline[1]) : null;
}

function pickRegexGroup(match: RegExpMatchArray | null, group: string | number | undefined): string {
  if (!match) return "";
  if (typeof group === "string") return normalizeText(match.groups?.[group]);
  return normalizeText(match[group ?? 1]);
}

function createRuleRegex(pattern: string, flags = ""): RegExp {
  const literal = parseRulePattern(pattern);
  const inlineFlagMatch = literal.source.match(/^\(\?([imsu]+)\)/);
  const nextFlags = new Set([...flags, ...literal.flags].filter(Boolean));
  let source = literal.source;

  if (inlineFlagMatch) {
    source = literal.source.slice(inlineFlagMatch[0].length);
    inlineFlagMatch[1].split("").forEach((flag) => nextFlags.add(flag));
  }

  source = source.replace(/\(\?P<([A-Za-z][A-Za-z0-9_]*)>/g, "(?<$1>");
  return new RegExp(source, Array.from(nextFlags).join(""));
}

function parseRulePattern(pattern: string): { source: string; flags: string } {
  const trimmed = pattern.trim();
  const literal = trimmed.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/);
  return literal ? { source: literal[1].replace(/\\\//g, "/"), flags: literal[2] } : { source: trimmed, flags: "" };
}

function splitCards(rows: CellGrid, pattern: string): Array<{ startRow: number; rows: CellGrid }> {
  const regex = createRuleRegex(pattern);
  const starts = rows.reduce<number[]>((acc, row, index) => {
    if (row.some((cell) => regex.test(normalizeText(cell)))) acc.push(index);
    return acc;
  }, []);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? rows.length;
    return { startRow: start, rows: rows.slice(start, end) };
  });
}

function groupConsecutive(indexes: number[]): Array<{ start: number; end: number; count: number }> {
  const groups: Array<{ start: number; end: number; count: number }> = [];
  for (const index of indexes) {
    const current = groups[groups.length - 1];
    if (current && index === current.end + 1) {
      current.end = index;
      current.count += 1;
    } else {
      groups.push({ start: index, end: index, count: 1 });
    }
  }
  return groups;
}

function renderTemplate(template: string | undefined, values: Record<string, string | number>): string {
  if (!template) return "";
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => normalizeText(values[key]));
}

function findNearestQuantity(lines: string[], start: number, end: number): number {
  for (let i = start; i < Math.min(lines.length, end); i += 1) {
    const value = toPositiveNumber(lines[i]);
    if (value > 0 && /^-?\d+(?:\.\d+)?$/.test(lines[i])) return value;
  }
  for (let i = start; i < Math.min(lines.length, end); i += 1) {
    const value = toPositiveNumber(lines[i]);
    if (value > 0) return value;
  }
  return 0;
}

function toOrder(
  mapped: Partial<Record<OrderField, string | number>>,
  sourceSheet?: string,
  sourceRow?: number,
  sourceBlock?: string,
): ParsedOrder {
  const normalized = { ...FIELD_DEFAULTS, ...mapped };
  return {
    id: "",
    externalCode: normalizeText(normalized.externalCode),
    receiverShop: normalizeText(normalized.receiverShop),
    receiverName: normalizeText(normalized.receiverName),
    receiverPhone: normalizeText(normalized.receiverPhone),
    receiverAddress: normalizeText(normalized.receiverAddress),
    skuCode: normalizeText(normalized.skuCode),
    skuName: normalizeText(normalized.skuName),
    qty: toPositiveNumber(normalized.qty),
    skuSpec: normalizeText(normalized.skuSpec),
    remark: normalizeText(normalized.remark),
    sourceSheet,
    sourceRow,
    sourceBlock,
  };
}

function hasAnySkuSignal(mapped: Partial<Record<OrderField, string | number>>): boolean {
  return Boolean(normalizeText(mapped.skuCode) || normalizeText(mapped.skuName));
}

function selectSheets(sheets: SheetSnapshot[], rule: ParseRule): SheetSnapshot[] {
  if (rule.sheetMode === "all") return sheets;
  if (rule.sheetMode === "named" && rule.sheetNames?.length) {
    const names = new Set(rule.sheetNames);
    return sheets.filter((sheet) => names.has(sheet.name));
  }
  return sheets.slice(0, 1);
}

function withStableIds(rows: ParsedOrder[]): ParsedOrder[] {
  return rows.map((row, index) => ({
    ...row,
    id: `${row.sourceSheet ?? "file"}-${row.sourceRow ?? index + 1}-${index + 1}`,
  }));
}

function trimGrid(rows: CellGrid): CellGrid {
  const trimmedRows = rows.map((row) => {
    let last = row.length - 1;
    while (last >= 0 && !normalizeText(row[last])) last -= 1;
    return row.slice(0, last + 1);
  });

  let lastRow = trimmedRows.length - 1;
  while (lastRow >= 0 && trimmedRows[lastRow].every((cell) => !normalizeText(cell))) {
    lastRow -= 1;
  }

  return trimmedRows.slice(0, lastRow + 1);
}

function fillMergedCells(worksheet: XLSX.WorkSheet, rows: CellGrid): CellGrid {
  const output = rows.map((row) => [...row]);
  const merges = worksheet["!merges"] ?? [];

  for (const merge of merges) {
    const value = normalizeText(output[merge.s.r]?.[merge.s.c]);
    if (!value) continue;
    for (let rowIndex = merge.s.r; rowIndex <= merge.e.r; rowIndex += 1) {
      output[rowIndex] ??= [];
      for (let colIndex = merge.s.c; colIndex <= merge.e.c; colIndex += 1) {
        if (!normalizeText(output[rowIndex][colIndex])) {
          output[rowIndex][colIndex] = value;
        }
      }
    }
  }

  return output;
}

function flattenRows(rows: CellGrid): string {
  return rows.map((row) => row.map((cell) => normalizeText(cell)).filter(Boolean).join(" ")).join("\n");
}

async function extractPdfText(file: File): Promise<string> {
  ensurePdfJsNodeGlobals();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
  ).href;
  const data = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data, useWorkerFetch: false }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join("\n");
    pages.push(text);
  }
  return pages.join("\n");
}

type PdfDomMatrixInit =
  | number[]
  | {
      a?: number;
      b?: number;
      c?: number;
      d?: number;
      e?: number;
      f?: number;
      m11?: number;
      m12?: number;
      m21?: number;
      m22?: number;
      m41?: number;
      m42?: number;
    };

class PdfDomMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: PdfDomMatrixInit) {
    if (Array.isArray(init)) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = [
        Number(init[0] ?? 1),
        Number(init[1] ?? 0),
        Number(init[2] ?? 0),
        Number(init[3] ?? 1),
        Number(init[4] ?? 0),
        Number(init[5] ?? 0),
      ];
      return;
    }

    if (init && typeof init === "object") {
      this.a = Number(init.a ?? init.m11 ?? 1);
      this.b = Number(init.b ?? init.m12 ?? 0);
      this.c = Number(init.c ?? init.m21 ?? 0);
      this.d = Number(init.d ?? init.m22 ?? 1);
      this.e = Number(init.e ?? init.m41 ?? 0);
      this.f = Number(init.f ?? init.m42 ?? 0);
    }
  }

  get m11() {
    return this.a;
  }

  set m11(value: number) {
    this.a = value;
  }

  get m12() {
    return this.b;
  }

  set m12(value: number) {
    this.b = value;
  }

  get m21() {
    return this.c;
  }

  set m21(value: number) {
    this.c = value;
  }

  get m22() {
    return this.d;
  }

  set m22(value: number) {
    this.d = value;
  }

  get m41() {
    return this.e;
  }

  set m41(value: number) {
    this.e = value;
  }

  get m42() {
    return this.f;
  }

  set m42(value: number) {
    this.f = value;
  }

  get is2D() {
    return true;
  }

  multiplySelf(other?: PdfDomMatrixInit) {
    const matrix = new PdfDomMatrix(other);
    const next = multiplyAffine(this, matrix);
    this.setFrom(next);
    return this;
  }

  preMultiplySelf(other?: PdfDomMatrixInit) {
    const matrix = new PdfDomMatrix(other);
    const next = multiplyAffine(matrix, this);
    this.setFrom(next);
    return this;
  }

  translate(x = 0, y = 0) {
    return new PdfDomMatrix(this.toArray()).translateSelf(x, y);
  }

  translateSelf(x = 0, y = 0) {
    return this.multiplySelf([1, 0, 0, 1, x, y]);
  }

  scale(scaleX = 1, scaleY = scaleX) {
    return new PdfDomMatrix(this.toArray()).scaleSelf(scaleX, scaleY);
  }

  scaleSelf(scaleX = 1, scaleY = scaleX) {
    return this.multiplySelf([scaleX, 0, 0, scaleY, 0, 0]);
  }

  invertSelf() {
    const determinant = this.a * this.d - this.b * this.c;
    if (!determinant) {
      this.a = Number.NaN;
      this.b = Number.NaN;
      this.c = Number.NaN;
      this.d = Number.NaN;
      this.e = Number.NaN;
      this.f = Number.NaN;
      return this;
    }

    const next = new PdfDomMatrix([
      this.d / determinant,
      -this.b / determinant,
      -this.c / determinant,
      this.a / determinant,
      (this.c * this.f - this.d * this.e) / determinant,
      (this.b * this.e - this.a * this.f) / determinant,
    ]);
    this.setFrom(next);
    return this;
  }

  toFloat32Array() {
    return Float32Array.from(this.toArray());
  }

  toFloat64Array() {
    return Float64Array.from(this.toArray());
  }

  toArray() {
    return [this.a, this.b, this.c, this.d, this.e, this.f];
  }

  private setFrom(matrix: PdfDomMatrix) {
    this.a = matrix.a;
    this.b = matrix.b;
    this.c = matrix.c;
    this.d = matrix.d;
    this.e = matrix.e;
    this.f = matrix.f;
  }
}

function multiplyAffine(left: PdfDomMatrix, right: PdfDomMatrix): PdfDomMatrix {
  return new PdfDomMatrix([
    left.a * right.a + left.c * right.b,
    left.b * right.a + left.d * right.b,
    left.a * right.c + left.c * right.d,
    left.b * right.c + left.d * right.d,
    left.a * right.e + left.c * right.f + left.e,
    left.b * right.e + left.d * right.f + left.f,
  ]);
}

function ensurePdfJsNodeGlobals() {
  const target = globalThis as unknown as {
    DOMMatrix?: typeof PdfDomMatrix;
    DOMMatrixReadOnly?: typeof PdfDomMatrix;
  };

  target.DOMMatrix ??= PdfDomMatrix;
  target.DOMMatrixReadOnly ??= PdfDomMatrix;
}

export type {
  CardRuleConfig,
  FieldMappings,
  FieldSource,
  GridRuleConfig,
  MatrixRuleConfig,
  ParsedOrder,
  ParseRule,
  TableRuleConfig,
};
