import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const integration = process.argv.includes("--integration");
if (integration) assert(process.env.DATABASE_URL, "Run integration checks inside the Compose server service.");
const client = new Client({ name: "smoke-check", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
  env: process.env,
  stderr: "inherit",
});
const testUri = `test://smoke/${randomUUID()}`;

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["ingest", "list_sources", "search"]);
  for (const args of [{}, { text: "missing metadata" },
    { text: "   ", uri: "demo://invalid", title: "Invalid" },
    { file_path: "example.md", url: "https://raw.githubusercontent.com/example.md" }]) {
    const result = await client.callTool({ name: "ingest", arguments: args });
    assert(result.isError, "Invalid ingestion input must be rejected");
  }
  console.log("PASS: MCP tool discovery and invalid input checks.");

  if (integration) {
    const document = { uri: testUri, title: "Fictional smoke check",
      text: "In this fictional smoke check, the rabbit mascot launch code is RABBIT-927." };
    const first = await call("ingest", document);
    assert.equal(first.chunks_count, 1);
    assert.equal(first.status, "ingested");
    const repeated = await call("ingest", document);
    assert.equal(repeated.status, "skipped");
    assert.equal(repeated.source_id, first.source_id);
    const found = await call("search", { query: "What is the rabbit mascot launch code in the fictional smoke check?", limit: 5 });
    assert(found.results.some((row) => row.uri === testUri && row.content.includes("RABBIT-927")));
    const updated = await call("ingest", { ...document, text: document.text.replace("927", "928") });
    assert.equal(updated.source_id, first.source_id);
    assert.equal(updated.status, "ingested");
    const page = await call("list_sources", { limit: 1, offset: 0 });
    assert.equal(page.sources.length, 1);
    console.log("PASS: ingestion, unchanged skip, search, update, and source listing.");
  }
} finally {
  await client.close();
  if (integration) {
    // Delete only this run's isolated test source, never existing user/corpus data.
    const { default: pg } = await import("pg");
    const database = new pg.Client({ connectionString: process.env.DATABASE_URL });
    try {
      await database.connect();
      await database.query("DELETE FROM sources WHERE uri = $1", [testUri]);
    } finally {
      await database.end();
    }
  }
}
