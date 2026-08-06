import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const storageRoot = process.env.IMPORT_STORAGE_DIR || path.join(process.cwd(), ".data", "imports");

export async function saveImportFile(taskId: string, file: File): Promise<string> {
  await mkdir(storageRoot, { recursive: true });
  const filePath = path.join(storageRoot, `${taskId}-${sanitizeFileName(file.name)}`);
  await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
  return filePath;
}

export async function readImportFile(filePath: string, fileName: string): Promise<File> {
  const data = await readFile(filePath);
  return new File([data], fileName, { type: mimeFor(fileName), lastModified: Date.now() });
}

export async function readParsedSnapshot<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(`${filePath}.parsed.json`, "utf8")) as T;
}

export async function writeParsedSnapshot(filePath: string, rows: unknown): Promise<void> {
  await writeFile(`${filePath}.parsed.json`, JSON.stringify(rows), "utf8");
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
