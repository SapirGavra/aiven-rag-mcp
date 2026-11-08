import { createEmbedder } from "../src/embeddings.js";

console.log("Downloading the embedding model into .cache/models...");
const model = await createEmbedder(false);
await model.dispose();
console.log("Model ready.");
