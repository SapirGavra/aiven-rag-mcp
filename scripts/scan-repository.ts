import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ScannedFile = {
  path: string;
  extension: string;
  bytes: number | null;
  status: "ready" | "empty" | "failed";
  error?: string;
};

const root = fileURLToPath(new URL("../data/devportal/", import.meta.url));
const reports = fileURLToPath(new URL("../data/reports/", import.meta.url));
const source = JSON.parse(await readFile(new URL("../data/devportal-source.json", import.meta.url), "utf8"));

function git(...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

// Scan one file without stopping the scan if it cannot be read.
async function scanFile(filePath: string): Promise<ScannedFile> {
  const extension = path.extname(filePath).toLowerCase();
  try {
    const bytes = await readFile(path.join(root, filePath));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      path: filePath,
      extension,
      bytes: bytes.length,
      status: text.trim() ? "ready" : "empty",
    };
  } catch (error) {
    return {
      path: filePath,
      extension,
      bytes: null,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// 1. Check that we are scanning the expected, unchanged repository.
if (git("rev-parse", "HEAD").trim() !== source.commit) {
  throw new Error("The repository must match the recorded commit.");
}
if (git("status", "--porcelain", "--untracked-files=all").trim()) {
  throw new Error("The repository must not contain local changes.");
}

// 2. Find every tracked Markdown and RST file, including subdirectories.
const paths = git("ls-files", "-z").split("\0")
  .filter((name) => [".md", ".markdown", ".rst"].includes(path.extname(name).toLowerCase()))
  .sort();

// 3. Read the files and count the results.
const files: ScannedFile[] = [];
const summary = { totalFiles: 0, totalBytes: 0, markdown: 0, rst: 0, ready: 0, empty: 0, failed: 0 };
for (const filePath of paths) {
  const file = await scanFile(filePath);
  files.push(file);
  summary.totalFiles++;
  summary.totalBytes += file.bytes ?? 0;
  if (file.extension === ".rst") summary.rst++;
  else summary.markdown++;
  summary[file.status]++;
}

// 4. Save the file list for ingestion and a summary for inspection.
await mkdir(reports, { recursive: true });
await writeFile(path.join(reports, "devportal-manifest.json"), JSON.stringify({ source, files }, null, 2) + "\n");
await writeFile(path.join(reports, "devportal-summary.json"), JSON.stringify({ source, ...summary }, null, 2) + "\n");
console.log(summary);
if (summary.failed > 0) process.exitCode = 1;
