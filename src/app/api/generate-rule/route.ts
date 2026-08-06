import { generateRuleWithLlm, getLlmProviderInfo } from "@/lib/llm";
import { ParserEngine } from "@/lib/parser-engine";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return Response.json({ success: false, error: "请上传一个文件用于生成规则" }, { status: 400 });
    }

    const structure = await ParserEngine.extractStructure(file);
    const localRule = await ParserEngine.generateLocalRule(structure);
    const llm = getLlmProviderInfo();

    try {
      const rule = await generateRuleWithLlm(structure, localRule);
      return Response.json({ success: true, rule, structure, aiFallback: false, llm });
    } catch (error) {
      const message = error instanceof Error ? error.message : "大模型接口调用失败";
      return Response.json({
        success: true,
        rule: {
          ...localRule,
          notes: [
            ...(localRule.notes ?? []),
            { message: `大模型接口暂不可用，已使用本地结构分析规则：${message}`, confidence: "medium" },
          ],
        },
        structure,
        aiFallback: true,
        llm,
      });
    }
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "规则生成失败" },
      { status: 500 },
    );
  }
}
