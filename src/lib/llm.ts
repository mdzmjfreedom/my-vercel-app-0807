import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import type { FileStructure, ParseRule } from "./types";
import { ORDER_FIELDS } from "./types";

type LlmConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
};

const AI_SDK_TIMEOUT_MS = 18_000;
const CHAT_COMPLETIONS_TIMEOUT_MS = 45_000;

export function getLlmProviderInfo() {
  return {
    baseURL: process.env.OPENAI_BASE_URL?.trim() ?? "",
    model: process.env.OPENAI_MODEL?.trim() ?? "",
  };
}

const fieldSourceSchema = z.union([
  z.object({
    kind: z.literal("column"),
    index: z.number().optional(),
    header: z.string().optional(),
    fallbackHeaders: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal("cell"), row: z.number(), col: z.number() }),
  z.object({
    kind: z.literal("label"),
    label: z.string(),
    offsetRows: z.number().optional(),
    offsetCols: z.number().optional(),
    searchFromRow: z.number().optional(),
  }),
  z.object({
    kind: z.literal("regex"),
    pattern: z.string(),
    group: z.union([z.number(), z.string()]).optional(),
    flags: z.string().optional(),
  }),
  z.object({ kind: z.literal("static"), value: z.union([z.string(), z.number()]) }),
  z.object({
    kind: z.literal("sheetName"),
    pattern: z.string().optional(),
    group: z.union([z.number(), z.string()]).optional(),
  }),
  z.object({ kind: z.literal("cardIndex"), prefix: z.string().optional() }),
]);

const fieldMappingsSchema = z
  .object({
    externalCode: fieldSourceSchema.optional(),
    receiverShop: fieldSourceSchema.optional(),
    receiverName: fieldSourceSchema.optional(),
    receiverPhone: fieldSourceSchema.optional(),
    receiverAddress: fieldSourceSchema.optional(),
    skuCode: fieldSourceSchema.optional(),
    skuName: fieldSourceSchema.optional(),
    qty: fieldSourceSchema.optional(),
    skuSpec: fieldSourceSchema.optional(),
    remark: fieldSourceSchema.optional(),
  })
  .partial();

const parseRuleSchema = z.object({
  ruleName: z.string(),
  fileType: z.enum(["excel", "word", "pdf"]),
  mode: z.enum(["table", "matrix", "grid", "cards", "text-sequence", "text-regex"]),
  sheetMode: z.enum(["first", "all", "named"]).optional(),
  sheetNames: z.array(z.string()).optional(),
  table: z
    .object({
      headerRow: z.number(),
      dataStartRow: z.number().optional(),
      dataEndRow: z.number().optional(),
      stopWhenFirstCellMatches: z.string().optional(),
      skipWhenFirstCellMatches: z.string().optional(),
      skipBlankRows: z.boolean().optional(),
      fieldMappings: fieldMappingsSchema,
      contextMappings: fieldMappingsSchema.optional(),
    })
    .optional(),
  matrix: z
    .object({
      headerRow: z.number(),
      dataStartRow: z.number(),
      dataEndRow: z.number().optional(),
      quantityColumnStart: z.number(),
      quantityColumnEnd: z.number().optional(),
      storeNameRow: z.number().optional(),
      skuMappings: fieldMappingsSchema,
      fixedMappings: fieldMappingsSchema.optional(),
      externalCodeTemplate: z.string().optional(),
    })
    .optional(),
  grid: z
    .object({
      headerRow: z.number(),
      dataStartRow: z.number(),
      dataEndRow: z.number().optional(),
      valueColumnStart: z.number(),
      valueColumnEnd: z.number().optional(),
      rowMappings: fieldMappingsSchema.optional(),
      fixedMappings: fieldMappingsSchema.optional(),
      itemSeparatorPattern: z.string().optional(),
      itemPattern: z.string().optional(),
      externalCodeTemplate: z.string().optional(),
      skuCodeFallback: z.enum(["skuName", "empty"]).optional(),
    })
    .optional(),
  cards: z
    .object({
      cardStartPattern: z.string(),
      itemHeaderPattern: z.string(),
      stopAtBlankRows: z.number().optional(),
      infoMappings: fieldMappingsSchema.optional(),
      itemMappings: fieldMappingsSchema,
    })
    .optional(),
  textSequence: z
    .object({
      itemCodePattern: z.string().optional(),
      minFieldsAfterCode: z.number().optional(),
      contextMappings: fieldMappingsSchema.optional(),
      itemFieldOrder: z.array(z.enum(["skuCode", "skuName", "skuSpec", "qty", "remark"])).optional(),
    })
    .optional(),
  textRegex: z
    .object({
      recordSeparatorPattern: z.string().optional(),
      itemLinePattern: z.string().optional(),
      contextMappings: fieldMappingsSchema.optional(),
    })
    .optional(),
  notes: z
    .array(
      z.object({
        field: z
          .enum([
            "externalCode",
            "receiverShop",
            "receiverName",
            "receiverPhone",
            "receiverAddress",
            "skuCode",
            "skuName",
            "qty",
            "skuSpec",
            "remark",
          ])
          .optional(),
        message: z.string(),
        confidence: z.enum(["high", "medium", "low"]),
      }),
    )
    .optional(),
});

export async function generateRuleWithLlm(structure: FileStructure, localRule: ParseRule): Promise<ParseRule> {
  const config = getLlmConfig();
  const customOpenAI = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
  const compactStructure = compactFileStructure(structure);
  const prompt = buildRulePrompt(compactStructure, localRule);

  try {
    return await generateRuleWithChatCompletions(prompt, config);
  } catch (chatError) {
    try {
      const result = await generateObject({
        model: customOpenAI(config.model),
        schema: parseRuleSchema,
        prompt,
        maxRetries: 0,
        timeout: { totalMs: AI_SDK_TIMEOUT_MS },
      });

      return result.object;
    } catch (sdkError) {
      throw new Error(
        `Chat Completions 流式调用失败：${errorMessage(chatError)}；AI SDK 兜底失败：${errorMessage(sdkError)}`,
      );
    }
  }
}

function buildRulePrompt(compactStructure: FileStructure, localRule: ParseRule): string {
  return `你是物流批量下单系统的解析规则架构师。请只生成“解析规则 JSON”，不要直接抽取订单数据。

目标字段:
${JSON.stringify(ORDER_FIELDS, null, 2)}

规则 DSL 说明:
- table: 标准表格，headerRow/dataStartRow 为 0 基下标；字段可用 column、label、regex、static、sheetName。
- matrix: SKU 行 + 门店/日期列的矩阵转置；quantityColumnStart/End 是数量列范围。
- grid: 门店/收货方为行，日期/门店为列，单元格内含“物品名x数量”的复合值；需拆分为多条 SKU 行。
- cards: 多个纵向卡片，先用 cardStartPattern 拆卡片，再找 itemHeaderPattern 后的小表。
- text-sequence/text-regex: PDF/Word 全文提取后按 SKU 编码附近文本或正则抽取。
- 坐标一律 0 基。必须标注低置信度推测 notes，方便用户确认。

文件结构概览:
${JSON.stringify(compactStructure, null, 2)}

本地启发式初稿，可在此基础上修正:
${JSON.stringify(localRule, null, 2)}
`;
}

function getLlmConfig(): LlmConfig {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  const model = process.env.OPENAI_MODEL?.trim();

  if (!apiKey || !baseURL || !model) {
    const missing: string[] = [];
    if (!apiKey) missing.push("OPENAI_API_KEY");
    if (!baseURL) missing.push("OPENAI_BASE_URL");
    if (!model) missing.push("OPENAI_MODEL");
    throw new Error(`缺少大模型环境变量：${missing.join("、")}`);
  }

  return { apiKey, baseURL, model };
}

async function generateRuleWithChatCompletions(prompt: string, config: LlmConfig): Promise<ParseRule> {
  const body = {
    model: config.model,
    stream: true,
    messages: [
      {
        role: "system",
        content:
          "你只返回一个符合规则 DSL 的 JSON 对象，不要返回 Markdown、解释、代码块或订单数据。所有坐标使用 0 基下标。",
      },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
  };

  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CHAT_COMPLETIONS_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 240)}`);
  }

  const content = parseChatCompletionContent(text);
  if (!content) throw new Error("大模型返回为空");
  return parseRuleSchema.parse(JSON.parse(extractJsonObject(content)));
}

function parseChatCompletionContent(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("data:")) {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]")
      .map((line) => JSON.parse(line) as ChatCompletionResponse)
      .map((chunk) => readChoiceText(chunk))
      .join("");
  }

  return readChoiceText(JSON.parse(trimmed) as ChatCompletionResponse);
}

type ChatCompletionResponse = {
  choices?: Array<{
    delta?: { content?: string };
    message?: { content?: string };
    text?: string;
  }>;
};

function readChoiceText(data: ChatCompletionResponse): string {
  return data.choices
    ?.map((choice) => choice.message?.content ?? choice.delta?.content ?? choice.text ?? "")
    .join("") ?? "";
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("大模型未返回 JSON 对象");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactFileStructure(structure: FileStructure): FileStructure {
  return {
    ...structure,
    sheets: structure.sheets?.map((sheet) => ({
      ...sheet,
      rows: sheet.rows.slice(0, 30).map((row) => row.slice(0, 45)),
    })),
    text: structure.text?.slice(0, 12000),
    pages: structure.pages?.map((page) => ({ ...page, text: page.text.slice(0, 5000) })),
  };
}
