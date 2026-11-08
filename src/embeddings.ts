import { env, pipeline } from "@huggingface/transformers";
import { fileURLToPath } from "node:url";

// Keep downloaded model files in the project, outside Git.
const cacheDirectory = fileURLToPath(new URL("../.cache/models/", import.meta.url));
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

export type Embedder = {
  countTokens(text: string): number;
  embed(text: string): Promise<number[]>;
  dispose(): Promise<void>;
};

// One model per running process, shared by ingestion and search.
let sharedModel: Promise<Embedder> | undefined;
export async function getEmbedder(): Promise<Embedder> {
  sharedModel ??= createEmbedder(true).catch((error) => {
    sharedModel = undefined;
    throw error;
  });
  return sharedModel;
}

export async function closeEmbedder() {
  if (sharedModel) {
    const model = await sharedModel;
    sharedModel = undefined;
    await model.dispose();
  }
}

export async function createEmbedder(localFilesOnly = false): Promise<Embedder> {
  env.localModelPath = cacheDirectory;
  env.allowRemoteModels = !localFilesOnly;
  const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
    device: "cpu",
    dtype: "fp32",
    cache_dir: cacheDirectory,
    local_files_only: localFilesOnly,
  });

  return {
    countTokens(text: string): number {
      return extractor.tokenizer.encode(text, { add_special_tokens: true }).length;
    },
    async embed(text: string): Promise<number[]> {
      if (!text.trim()) {
        throw new Error("Cannot embed empty text.");
      }

      const output = await extractor(text, { pooling: "mean", normalize: true });
      const vector = Array.from(output.data, Number);

      if (vector.length !== 384 || !vector.every(Number.isFinite)) {
        throw new Error("Expected an embedding containing 384 finite numbers.");
      }

      return vector;
    },
    async dispose() {
      await extractor.dispose();
    },
  };
}
