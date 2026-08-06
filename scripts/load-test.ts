import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { upload } from "@vercel/blob/client";

const baseUrl = process.env.LOAD_TEST_URL || "http://localhost:3000";
const filePath = process.env.LOAD_TEST_FILE || "test-data/10000-orders.xlsx";
const rulePath = process.env.LOAD_TEST_RULE || "docs/load-test-rule.json";

async function main() {
  const file = new File([await readFile(filePath)], "10000-orders.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const ruleText = await readFile(rulePath, "utf8");
  const started = performance.now();
  let response: Response;
  if (/^https:\/\//i.test(baseUrl)) {
    const blob = await upload(`imports/client/load-test-${crypto.randomUUID()}.xlsx`, file, {
      access: "private",
      handleUploadUrl: `${baseUrl}/api/import-uploads`,
      contentType: file.type,
      multipart: file.size >= 5 * 1024 * 1024,
    });
    response = await fetch(`${baseUrl}/api/import-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blobUrl: blob.url, fileName: file.name, totalRows: 10000, rule: JSON.parse(ruleText) }),
    });
  } else {
    const form = new FormData();
    form.append("file", file);
    form.append("rule", ruleText);
    response = await fetch(`${baseUrl}/api/import-tasks`, { method: "POST", body: form });
  }
  const uploadMs = Math.round(performance.now() - started);
  const created = await response.json() as { task_id?: string; error?: string };
  if (!response.ok || !created.task_id) throw new Error(created.error || `upload failed (${response.status})`);
  let latest: Record<string, unknown> = {};
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await fetch(`${baseUrl}/api/import-tasks/${created.task_id}`, { cache: "no-store" });
    latest = await status.json();
    if (["COMPLETED", "PARTIAL_SUCCESS", "FAILED"].includes(String(latest.status))) break;
  }
  const totalMs = Math.round(performance.now() - started);
  console.log(JSON.stringify({ uploadMs, totalMs, taskId: created.task_id, status: latest.status, successRows: latest.success_rows, failedRows: latest.failed_rows, targetMet: totalMs <= 60000, serverErrors: response.status >= 500 }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
