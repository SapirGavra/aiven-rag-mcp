import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Document = { uri: string; title: string; text: string };
export type IngestInput = {
  text?: string;
  uri?: string;
  title?: string;
  file_path?: string;
  url?: string;
};

const FILE_EXTENSIONS = [".txt", ".md", ".markdown", ".rst"];
const CONTENT_TYPES = ["text/plain", "text/markdown", "text/x-markdown", "text/x-rst"];
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

// All three input types become the same document before ingestion.
export async function readInput(input: IngestInput): Promise<Document> {
  const supplied = [input.text, input.file_path, input.url].filter((value) => value !== undefined);
  if (supplied.length !== 1) throw new Error("Provide exactly one of text, file_path, or url.");
  if (input.text !== undefined) {
    if (!input.uri?.trim() || !input.title?.trim() || !input.text.trim()) {
      throw new Error("Text ingestion requires non-empty text, uri, and title.");
    }
    return { uri: input.uri.trim(), title: input.title.trim(), text: input.text };
  }
  if (input.uri !== undefined || input.title !== undefined) {
    throw new Error("File and URL inputs generate their own uri and title.");
  }
  if (input.file_path !== undefined) return readFileInput(input.file_path);
  if (input.url !== undefined) return readUrlInput(input.url);
  throw new Error("Provide exactly one of text, file_path, or url.");
}

async function readFileInput(relativePath: string): Promise<Document> {
  if (path.isAbsolute(relativePath) || path.win32.parse(relativePath).root) {
    throw new Error("Use a relative path inside documents, for example example.md.");
  }
  const root = await realpath(fileURLToPath(new URL("../documents/", import.meta.url)));
  const target = await realpath(path.resolve(root, relativePath));
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("File must stay inside documents, including symbolic link targets.");
  }
  if (!FILE_EXTENSIONS.includes(path.extname(target).toLowerCase())) {
    throw new Error("Supported files: .txt, .md, .markdown, .rst.");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(target));
  const encodedPath = relative.split(path.sep).map(encodeURIComponent).join("/");
  return { uri: `file://documents/${encodedPath}`, title: path.basename(target), text };
}

async function readUrlInput(address: string): Promise<Document> {
  const url = allowedUrl(address);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const text = await readDownloadedText(response);
  return { uri: url.href, title: path.posix.basename(url.pathname) || url.hostname, text };
}

// Validate the destination before making a network request.
function allowedUrl(address: string): URL {
  const url = new URL(address);
  const hosts = (process.env.INGEST_ALLOWED_HOSTS ?? "raw.githubusercontent.com")
    .split(",").map((host) => host.trim().toLowerCase());
  if (url.protocol !== "https:" || url.username || url.password ||
      !hosts.includes(url.hostname.toLowerCase()) || (url.port && url.port !== "443")) {
    throw new Error("Use HTTPS on an allowed host (INGEST_ALLOWED_HOSTS), without credentials.");
  }
  url.hash = "";
  return url;
}

// Read incrementally so an oversized response is stopped during download.
async function readDownloadedText(response: Response): Promise<string> {
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!response.ok || !type || !CONTENT_TYPES.includes(type)) {
    await response.body?.cancel();
    throw new Error(`Expected raw text/Markdown/RST; HTTP ${response.status}. HTML is unsupported.`);
  }
  if (!response.body) throw new Error("URL response has no content.");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) throw new Error("URL content exceeds 2 MiB.");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
}
