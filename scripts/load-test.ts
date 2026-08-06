import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const baseUrl = process.env.LOAD_TEST_URL || "http://localhost:3000";
const filePath = process.env.LOAD_TEST_FILE || "test-data/10000-orders.xlsx";
const rulePath = process.env.LOAD_TEST_RULE || "docs/load-test-rule.json";

async function main() {
  const form = new FormData();
  form.append("file", new Blob([await readFile(filePath)]), "10000-orders.xlsx");
  form.append("rule", await readFile(rulePath, "utf8"));
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/import-tasks`, { method: "POST", body: form });
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
