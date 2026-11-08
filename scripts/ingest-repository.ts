import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeEmbedder } from "../src/embeddings.js";
import { ingestText } from "../src/rag.js";

type SourceFile = { path: string; status: string };
type Manifest = {
  source: { repository: string; commit: string };
  files: SourceFile[];
};
type FileResult = {
  path: string;
  status: "ingested" | "skipped" | "empty" | "failed";
  chunks: number;
  error?: string;
};

const root = fileURLToPath(new URL("../data/devportal/", import.meta.url));
const reports = fileURLToPath(new URL("../data/reports/", import.meta.url));

// 1. Read the file list created by scan-repository.ts.
const manifest: Manifest = JSON.parse(
  await readFile(path.join(reports, "devportal-manifest.json"), "utf8")
);

async function ingestFile(file: SourceFile): Promise<FileResult> {
  try {
    if (file.status !== "ready" && file.status !== "empty") {
      throw new Error(`File cannot be ingested: ${file.status}`);
    }
    const bytes = await readFile(path.join(root, file.path));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.trim()) return { path: file.path, status: "empty", chunks: 0 };

    // Link each result to the exact GitHub version of its source file.
    const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
    const uri = `https://github.com/aiven/devportal/blob/${manifest.source.commit}/${encodedPath}`;
    const firstLine = text.split(/\r?\n/).find((line) => line.trim());
    const title = firstLine?.replace(/^#+\s*/, "").trim() || file.path;
    const result = await ingestText({ uri, title, text });
    return { path: file.path, status: result.status, chunks: result.chunks_count };
  } catch (error) {
    return {
      path: file.path,
      status: "failed",
      chunks: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// 2. Ingest one file at a time and record each result.
const results: FileResult[] = [];
const summary = {
  expected: manifest.files.length,
  processed: 0,
  ingested: 0,
  skipped: 0,
  empty: 0,
  failed: 0,
  total_chunks: 0,
};
console.log("Files to process:", summary.expected);
try {
  for (const file of manifest.files) {
    const result = await ingestFile(file);
    results.push(result);
    summary.processed++;
    summary[result.status]++;
    summary.total_chunks += result.chunks;
    console.log(`[${summary.processed}/${summary.expected}] ${result.status}: ${result.path}`);
    if (result.error) console.error(result.error);
  }
} finally {
  await closeEmbedder();
}

// 3. Save a report, including failures, after all files have been processed.
const completed = summary.processed === summary.expected && summary.failed === 0;
await mkdir(reports, { recursive: true });
await writeFile(path.join(reports, "devportal-ingestion.json"),
  JSON.stringify({ source: manifest.source, completed, summary, files: results }, null, 2) + "\n");
console.log("Ingestion summary:", summary);
console.log("Completed:", completed);
if (!completed) process.exitCode = 1;
