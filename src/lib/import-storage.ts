import { get, head, put } from "@vercel/blob";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const storageRoot = process.env.IMPORT_STORAGE_DIR || path.join(process.cwd(), ".data", "imports");

export function usesBlobStorage(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim() || process.env.BLOB_STORE_ID?.trim());
}

export async function saveImportFile(taskId: string, file: File): Promise<string> {
  if (usesBlobStorage()) {
    const pathname = `imports/${taskId}/${sanitizeFileName(file.name)}`;
    const blob = await put(pathname, file, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: file.type || mimeFor(file.name),
      multipart: file.size >= 5 * 1024 * 1024,
    });
    return blob.url;
  }

  await mkdir(storageRoot, { recursive: true });
  const filePath = path.join(storageRoot, `${taskId}-${sanitizeFileName(file.name)}`);
  await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
  return filePath;
}

export async function validateImportBlob(url: string, fileName: string): Promise<string> {
  if (!isBlobPath(url)) throw new Error("导入文件地址无效");
  const blob = await head(url);
  if (!blob.pathname.startsWith("imports/client/")) throw new Error("导入文件不在允许的 Blob 路径中");
  if (blob.size > 100 * 1024 * 1024) throw new Error("导入文件不能超过 100 MB");
  const expectedSuffix = fileName.split(".").pop()?.toLowerCase();
  const actualSuffix = blob.pathname.split(".").pop()?.toLowerCase();
  if (!expectedSuffix || expectedSuffix !== actualSuffix || !["xlsx", "xls", "docx", "pdf"].includes(expectedSuffix)) {
    throw new Error("导入文件格式不匹配");
  }
  return blob.url;
}

export async function readImportFile(filePath: string, fileName: string): Promise<File> {
  const data = isBlobPath(filePath)
    ? await readBlob(filePath)
    : await readFile(filePath);
  return new File([new Uint8Array(data)], fileName, { type: mimeFor(fileName), lastModified: Date.now() });
}

export async function readParsedSnapshot<T>(filePath: string): Promise<T> {
  const snapshot = snapshotPath(filePath);
  const data = isBlobPath(filePath)
    ? Buffer.from(await readBlob(snapshot)).toString("utf8")
    : await readFile(snapshot, "utf8");
  return JSON.parse(data) as T;
}

export async function writeParsedSnapshot(filePath: string, rows: unknown): Promise<void> {
  const snapshot = snapshotPath(filePath);
  const json = JSON.stringify(rows);
  if (isBlobPath(filePath)) {
    await put(blobPathname(snapshot), json, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
    return;
  }
  await writeFile(snapshot, json, "utf8");
}

export async function writeParsedBatchSnapshots(filePath: string, batches: unknown[][]): Promise<void> {
  await Promise.all(batches.map(async (rows, index) => {
    const snapshot = batchSnapshotPath(filePath, index);
    const json = JSON.stringify(rows);
    if (isBlobPath(filePath)) {
      await put(blobPathname(snapshot), json, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      });
      return;
    }
    await writeFile(snapshot, json, "utf8");
  }));
}

export async function readParsedBatchSnapshot<T>(filePath: string, batchIndex: number): Promise<T> {
  const snapshot = batchSnapshotPath(filePath, batchIndex);
  const data = isBlobPath(filePath)
    ? Buffer.from(await readBlob(snapshot)).toString("utf8")
    : await readFile(snapshot, "utf8");
  return JSON.parse(data) as T;
}

async function readBlob(url: string): Promise<ArrayBuffer> {
  const result = await get(url, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) throw new Error(`Import blob not found: ${url}`);
  return new Response(result.stream).arrayBuffer();
}

function snapshotPath(filePath: string): string {
  return `${filePath}.parsed.json`;
}

function batchSnapshotPath(filePath: string, batchIndex: number): string {
  return `${filePath}.batch-${String(batchIndex).padStart(4, "0")}.json`;
}

function blobPathname(url: string): string {
  return new URL(url).pathname.replace(/^\/+/, "");
}

function isBlobPath(value: string): boolean {
  return /^https:\/\//i.test(value);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "upload.bin";
}

function mimeFor(name: string): string {
  const suffix = name.split(".").pop()?.toLowerCase();
  if (suffix === "xlsx" || suffix === "xls") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (suffix === "pdf") return "application/pdf";
  if (suffix === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return "application/octet-stream";
}
