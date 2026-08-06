export function jsonError(message: string, status = 500) {
  if (status >= 500) console.error(message);
  const safeMessage = status >= 500 && (message.length > 240 || /prisma|database server|invocation|turbopack/i.test(message))
    ? "服务暂不可用，请稍后重试并检查数据库连接"
    : message;
  return Response.json({ success: false, error: safeMessage }, { status });
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}
