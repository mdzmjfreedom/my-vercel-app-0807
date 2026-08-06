import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { jsonError } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 30;

const allowedContentTypes = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "application/octet-stream",
];

export async function POST(req: Request) {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return jsonError("Blob 客户端上传未配置", 503);
    const body = await req.json() as HandleUploadBody;
    const result = await handleUpload({
      request: req,
      body,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith("imports/client/")) throw new Error("不允许的 Blob 上传路径");
        if (!/\.(xlsx|xls|docx|pdf)$/i.test(pathname)) throw new Error("不支持的导入文件格式");
        return {
          allowedContentTypes,
          maximumSizeInBytes: 100 * 1024 * 1024,
          addRandomSuffix: false,
          allowOverwrite: false,
        };
      },
    });
    return Response.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "生成 Blob 上传凭证失败");
  }
}
