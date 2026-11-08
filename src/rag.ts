import { createHash } from "node:crypto";
import pg from "pg";
import { getEmbedder, EMBEDDING_MODEL } from "./embeddings.js";
import { splitText } from "./chunking.js";
import type { Document } from "./inputs.js";

async function connectDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  return client;
}

export async function ingestText(document: Document) {
  const { uri, title, text } = document;
  if (!uri.trim() || !title.trim() || !text.trim()) throw new Error("Source and text must not be empty.");
  const model = await getEmbedder();
  const chunks = splitText(text, model.countTokens).filter((chunk) => chunk.trim());
  const hash = createHash("sha256").update(text).digest("hex");
  const client = await connectDatabase();
  try {
    // Transactions make each source complete; this count also catches missing chunks.
    const existing = await client.query<{ id: string }>(
      `SELECT s.id FROM sources s
       WHERE uri = $1 AND title = $2 AND content_hash = $3
         AND embedding_model = $4
         AND (SELECT count(*) FROM chunks c WHERE c.source_id = s.id) = $5`,
      [uri, title, hash, EMBEDDING_MODEL, chunks.length],
    );
    if (existing.rows[0]) {
      return { source_id: existing.rows[0].id, uri, title, chunks_count: chunks.length, status: "skipped" as const };
    }

    const vectors: number[][] = [];
    for (const chunk of chunks) vectors.push(await model.embed(chunk));

    await client.query("BEGIN");
    try {
      const source = await client.query<{ id: string }>(
        `INSERT INTO sources (uri, title, content_hash, embedding_model)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (uri) DO UPDATE SET title = EXCLUDED.title,
           content_hash = EXCLUDED.content_hash, embedding_model = EXCLUDED.embedding_model,
           updated_at = NOW()
         RETURNING id`,
        [uri, title, hash, EMBEDDING_MODEL],
      );
      const id = source.rows[0]!.id;
      await client.query("DELETE FROM chunks WHERE source_id = $1", [id]);
      for (const [position, content] of chunks.entries()) {
        await client.query(
          "INSERT INTO chunks (source_id, position, content, embedding) VALUES ($1, $2, $3, $4::vector)",
          [id, position, content, JSON.stringify(vectors[position])],
        );
      }
      await client.query("COMMIT");
      return { source_id: id, uri, title, chunks_count: chunks.length, status: "ingested" as const };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}

export async function search(query: string, limit: number) {
  const model = await getEmbedder();
  const vector = await model.embed(query);
  const client = await connectDatabase();
  try {
    const result = await client.query<{
      chunk_id: string; title: string; uri: string; content: string; similarity: number;
    }>(
      `SELECT c.id AS chunk_id, s.title, s.uri, c.content,
              1 - (c.embedding <=> $1::vector) AS similarity
       FROM chunks c JOIN sources s ON c.source_id = s.id
       WHERE s.embedding_model = $2
       ORDER BY c.embedding <=> $1::vector ASC, c.id ASC LIMIT $3`,
      [JSON.stringify(vector), EMBEDDING_MODEL, limit],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

export async function listSources(limit: number, offset: number) {
  const client = await connectDatabase();
  try {
    const result = await client.query<{
      id: string; uri: string; title: string; embedding_model: string; chunks_count: number;
    }>(
      `SELECT s.id, s.uri, s.title, s.embedding_model,
              (SELECT count(*)::integer FROM chunks c WHERE c.source_id = s.id) AS chunks_count
       FROM sources s ORDER BY s.id ASC LIMIT $1 OFFSET $2`,
      [limit + 1, offset],
    );
    return { sources: result.rows.slice(0, limit),
      next_offset: result.rows.length > limit ? offset + limit : null };
  } finally {
    await client.end();
  }
}
