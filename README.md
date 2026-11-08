# Aiven RAG MCP

A TypeScript MCP server that lets Claude ingest documents and retrieve relevant
passages from them. It uses PostgreSQL with pgvector and the local
`Xenova/all-MiniLM-L6-v2` embedding model on CPU. The server requires no API key.
Claude generates the final answer; this server returns passages and their sources.

## Prerequisites

- Docker Desktop running Linux containers, with Docker Compose available.
- Claude Code for the interactive MCP demo.
- Git and Node.js 22+ for the repository scan and local development checks.
- Internet access for the initial image, package, model and repository downloads.

Commands below use PowerShell. Run them from the project directory. On other
shells, use `npm` instead of `npm.cmd` and adapt the example paths.

## Build and start

Build the server image:

```powershell
docker compose build server
```

Create the model directory and download the model once. The directory is mounted
writable so the preparation script can save the downloaded files:

```powershell
New-Item -ItemType Directory -Force -Path ".cache/models"
docker compose run --rm --no-deps server node --import tsx scripts/prepare-model.ts
```

Start the database and wait until it accepts connections:

```powershell
docker compose up -d --wait db
```

On an empty database volume, PostgreSQL runs `db/init.sql` to enable pgvector,
then `db/schema.sql` to create the tables. The named volume `postgres_data`
persists data across container restarts and `docker compose down`. Init scripts
do not run again for an existing database; editing the schema file does not
migrate existing tables.

Compose supplies `DATABASE_URL` automatically. Its database name, username and
password are local development values defined in `docker-compose.yml`; no
external credentials are needed. The embedding files must be downloaded before
search or ingestion can run.

The next step starts the MCP server on demand through Claude Code. A separate
background server is not needed for this stdio connection. For a direct attached
Compose run that also starts the database dependency, use `docker compose run
--rm -T server`; stdout is the MCP protocol stream, not a chat interface.

A clean installation has not yet been timed. First-run duration depends on image
and model downloads; full-corpus ingestion is a separate step below.

## Connect Claude Code

Edit the project `.mcp.json` using this configuration. Replace
`C:/path/to/RAG_MCP` with the absolute path to your checkout:

```json
{
  "mcpServers": {
    "aiven-rag": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "compose",
        "--project-directory", "C:/path/to/RAG_MCP",
        "run", "--rm", "--no-deps", "-T", "server"
      ]
    }
  }
}
```

Open Claude Code in the project directory and enable the project MCP server if
prompted. The database must already be running because this configuration uses
`--no-deps`. Use `/mcp` to inspect the connection.

First ask Claude:

```text
Use the aiven-rag list_sources tool with limit set to 2. Show the raw result.
```

An empty source list is expected before ingestion. After code changes, rebuild
with `docker compose build server` and reconnect the MCP server in Claude Code.
Logs go to stderr; stdout is reserved for MCP messages.

## Example session

Run this example after connecting the MCP server. Paste the prompts below into
the Claude Code conversation, not PowerShell. Loading the Aiven corpus is not
required for this example.

### Step 1: Store a document

Paste this entire message into Claude Code:

```text
Use the aiven-rag ingest tool with exactly these arguments:
{
  "uri": "demo://example",
  "title": "Fictional example",
  "text": "In this fictional example, the launch code is BLUE-742."
}
Show the raw tool result.
```

On first ingestion, expect a result like this (the source ID will vary):

```json
{
  "source_id": "1",
  "uri": "demo://example",
  "title": "Fictional example",
  "chunks_count": 1,
  "status": "ingested"
}
```

If the exact document already exists, `status` will be `skipped` instead.

### Step 2: Retrieve the answer

Paste this message into Claude Code:

```text
Use the aiven-rag search tool with exactly these arguments:
{"query":"What is the launch code in the fictional example?","limit":5}

Answer using only the retrieved passages. Include the supporting passage and
source URI. If the passages do not contain the answer, say so.
```

Expected answer content (Claude's wording may vary):

```text
The launch code is BLUE-742.
Source: demo://example
Supporting passage: "In this fictional example, the launch code is BLUE-742."
```

The search tool returns passages and similarity scores; Claude writes the answer
above. Up to five chunks may be returned, including unrelated passages if other
documents are present. The code and supporting source are the success criteria,
not an exact similarity score or identical answer wording.

### Optional: Check repeated ingestion

Send the Step 1 prompt again without changing any fields. Expect `status:
"skipped"` and the same `source_id`. Changing the text while keeping the URI
updates the existing source and replaces its chunks.

## Tools and supported inputs

### ingest

Provide exactly one input form:

```json
{"uri":"demo://example","title":"Example","text":"A fictional launch code is BLUE-742."}
```

```json
{"file_path":"example.md"}
```

```json
{"url":"https://raw.githubusercontent.com/aiven/devportal/9848c927b389232adede0edcf0a4b6d8acab0a63/docs/platform/reference/password-policy.rst"}
```

- Direct text requires a non-empty URI and title.
- Files must be UTF-8 `.txt`, `.md`, `.markdown` or `.rst` inside `documents/`.
  Absolute paths and paths escaping that directory, including symlink targets,
  are rejected. There is currently no explicit local file-size limit.
- URLs must serve raw UTF-8 text, Markdown or RST over HTTPS. Downloads have a
  15-second timeout and a 2 MiB limit. HTML, redirects and embedded credentials
  are unsupported. A repository homepage is not a bulk-ingestion endpoint.
- URL hosts default to `raw.githubusercontent.com`. To allow another trusted
  host, add `INGEST_ALLOWED_HOSTS` to `server.environment` in Compose, using a
  comma-separated list. This optional variable replaces the default host list.
- File and URL inputs generate their own URI and title; do not supply those
  fields with them. URL titles use the final path component or the hostname.

### search

```json
{"query":"What is the fictional launch code?","limit":5}
```

Returns chunk IDs, content, source titles, source URIs and cosine similarity.
The default limit is 5, with a supported range of 1-10. These are chunks, not
necessarily distinct documents. Similarity is not confidence, and results may
not contain an answer. Retrieved content should be treated as evidence, not
instructions.

### list_sources

```json
{"limit":20,"offset":0}
```

Returns sources and numeric chunk counts. Follow `next_offset` for another page;
`null` means there are no further sources at the time of the request. Source and
chunk IDs remain strings to preserve PostgreSQL bigint precision.

## Load the full Aiven repository

The corpus is the assignment's `aiven/devportal` repository at commit
`9848c927b389232adede0edcf0a4b6d8acab0a63`. It is pinned for reproducibility;
answers describe that version of the documentation.

For a new checkout of the documentation, download the exact commit:

```powershell
git init data/devportal
git -C data/devportal remote add origin https://github.com/aiven/devportal.git
git -C data/devportal fetch --depth 1 origin 9848c927b389232adede0edcf0a4b6d8acab0a63
git -C data/devportal checkout --detach FETCH_HEAD
```

If `data/devportal` already exists, do not repeat this initialization. Check its
commit with `git -C data/devportal rev-parse HEAD`; the scan requires the commit
recorded in `data/devportal-source.json` and an unchanged checkout.

Install local dependencies, scan the files, then ingest them through Docker:

```powershell
npm.cmd ci
npm.cmd run scan
docker compose run --rm server npm run ingest:repo
```

The scan enumerates all tracked `.md`, `.markdown` and `.rst` files throughout
the repository, including includes and repository metadata documents. It writes:

- `data/reports/devportal-manifest.json`: the file list consumed by ingestion.
- `data/reports/devportal-summary.json`: scan counts and file sizes.
- Ingestion then writes `data/reports/devportal-ingestion.json` with per-file
  outcomes and a final summary.

The verified corpus load processed 845 files: 844 non-empty and one empty,
producing 7,122 chunks with zero failures. Expect `Completed: true` and
`failed: 0`. Additional demo sources can increase database totals.

Ingestion processes one file at a time using the same `ingestText` function as
the MCP tool. Re-running skips unchanged sources. Each document is committed
separately, so completed documents survive an interrupted run. The report is
written only at the end; an older report does not describe an interrupted run.
Re-scan after changing the documentation checkout. The ingestion script itself
does not revalidate its commit, and does not delete sources removed from the repo.

## Checks and observed results

Local checks, after `npm.cmd ci`:

```powershell
npm.cmd run check
npm.cmd run smoke
```

`check` type-checks `src/`. `smoke` builds the application, connects an MCP client,
checks tool discovery and verifies rejection of invalid ingestion inputs. These
checks passed during development.

For database and model integration checks, with the model prepared and the image
rebuilt:

```powershell
docker compose run --rm server node scripts/smoke.mjs --integration
```

This checks ingest, unchanged-content skipping, search, update and source
listing, then removes only its uniquely named temporary source. The command is
provided for repeatable verification; the manual checks below are separate.

Manual checks through Claude Code produced these results:

| Check | Observed result |
| --- | --- |
| Source listing | Returned sources and a next-page offset. |
| Direct text ingestion and search | Retrieved the fictional code with its source URI. |
| Identical re-ingestion | Returned `skipped` with the same source ID. |
| Updated text | Kept the source ID and retrieved the new code. |
| Approximately 700-word document | Produced 8 chunks and retrieved the code near its end. |
| Local file ingestion and search | Retrieved `FILE-927` from `file://documents/example.md`. |
| Raw URL ingestion | Stored `password-policy.rst` as 2 chunks. |
| Missing text metadata | Rejected the call with a clear error. |
| Database restart | Previously stored, updated content remained searchable. |
| Password and resource-tag limits | Retrieved passages supporting 8 characters and 10 tags. |
| CLI tag instructions | Found command examples and arguments; the parameter table required four searches in the observed Claude session. |

These are small manual checks, not a broad retrieval benchmark. The CLI answer
combined several searches; it is not evidence of complete first-query recall.
Demo documents remain in the database unless explicitly removed.

## Design and code structure

| File | Responsibility |
| --- | --- |
| `src/server.ts` | Register MCP tools, validate inputs and format responses. |
| `src/inputs.ts` | Read direct text, a local file or an allowed raw-text URL. |
| `src/chunking.ts` | Recursively split text into chunks of at most 200 model tokens. |
| `src/embeddings.ts` | Load one local model per process, count tokens and embed text. |
| `src/rag.ts` | Ingest, search and list sources with parameterized SQL. |
| `db/init.sql`, `db/schema.sql` | Enable pgvector and create the tables. |
| `scripts/prepare-model.ts` | Download the embedding model before normal operation. |
| `scripts/scan-repository.ts` | Enumerate and check corpus files. |
| `scripts/ingest-repository.ts` | Ingest the manifest and report per-file outcomes. |
| `scripts/smoke.mjs` | Run MCP smoke and optional integration checks. |

Ingestion: input -> chunks -> embeddings -> PostgreSQL.
Search: query -> embedding -> nearest stored chunks -> passages and sources.

- A small local CPU model keeps setup independent of hosted embedding APIs.
- The MCP SDK handles protocol details; Zod validates tool inputs. The `pg`
  driver provides database access, and Transformers.js runs the model.
- `sources` stores document metadata; `chunks` stores text and 384-dimensional
  vectors linked to a source. A transaction replaces a source's chunks together.
- Matching URI, title, content hash, model and chunk count allows re-ingestion
  to skip embedding computation. There is no processing-version mechanism.
- Simple midpoint splitting enforces a token budget without another dependency.
  It does not understand document sections or tables.
- Sequential processing and a fresh database connection per operation keep the
  implementation small. There is no connection pool or dedicated vector index.

## Limitations and possible next steps

- RST includes and substitutions are stored as written rather than resolved.
- Chunk boundaries can separate headings, tables, examples and their context.
  There is no overlap between chunks.
- Retrieval is vector-only, without a relevance threshold or reranker. Exact
  parameter names and multi-part instructions can require additional searches.
- Sources are identified by exact URI. A GitHub `blob` URL and its corresponding
  `raw` URL are separate sources, even when their content matches.
- Titles use simple rules; a frontmatter opening line such as `---` can become a
  corpus document title.
- Changing chunking or embedding settings may require explicit re-ingestion;
  unchanged-content skipping does not track processing changes.
- URL access is deliberately restricted, and HTML/PDF extraction is unsupported.

Before adding complexity, measure retrieval quality and latency on a wider set
of questions with known supporting pages.

| Change in workload | What I would measure and consider |
| --- | --- |
| 10x more content | Measure query latency and recall; consider a pgvector index, section-aware chunks and hybrid keyword/vector search. |
| 10x more requests | Measure CPU, memory and connection pressure; consider a connection pool, bounded concurrency, batching and additional workers as needed. Each worker loads its own model. |
| Frequent content changes | Track changed and deleted files, update affected sources and define a deliberate reprocessing procedure when model or chunking settings change. |
