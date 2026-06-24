// Public MCP server for togo — exposes docs, the plugin marketplace, and plugin
// submission to any MCP client/agent over Streamable HTTP (stateless).
import express from "express";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const SITE = "https://to-go.dev";
const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(__dirname, "../data/catalog.json"), "utf8")) as {
  repos: Array<{ name: string; slug: string; description: string; language: string; stars: number; kind: string; category: string; install: string | null }>;
};
const repos = catalog.repos;
const plugins = repos.filter((r) => r.kind === "plugin");

async function fetchDoc(slug: string): Promise<string | null> {
  for (const url of [`${SITE}/docs/${slug}.md`, `https://raw.githubusercontent.com/togo-framework/${slug}/HEAD/README.md`]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const t = await r.text(); if (t.trim()) return t; }
    } catch { /* try next */ }
  }
  return null;
}

function makeServer(): McpServer {
  const server = new McpServer(
    { name: "togo", version: "0.1.0" },
    { instructions: "togo is an open-source, API-first full-stack framework (Go + sqlc + Atlas + React) with a Laravel-artisan-grade CLI. Use these tools to read togo docs, browse the plugin marketplace, and submit a plugin to it." }
  );

  server.tool("framework_overview", "What togo is, its stack, and how to start a project.", {}, async () => ({
    content: [{ type: "text", text:
`# ToGO
Open-source, API-first full-stack framework — ships your Go backend + React frontend as a single binary.

**Stack:** Go · chi · Huma (REST/OpenAPI) · gqlgen (GraphQL) · sqlc · Atlas migrations · React (TanStack/Next.js) · @togo-framework/ui · MCP-native.

**Quick start**
\`\`\`bash
npm install -g @togo-framework/cli      # or: curl -fsSL ${SITE}/install.sh | sh
togo new myapp                           # pick a frontend + database
cd myapp && togo make:resource Post title:string body:text
togo generate && togo migrate && togo serve
\`\`\`

Site ${SITE} · Docs ${SITE}/docs · Plugins ${SITE}/plugins · GitHub https://github.com/togo-framework
${repos.length} repos · ${plugins.length} installable plugins.` }],
  }));

  server.tool("list_plugins", "List the togo plugin marketplace (installable capabilities).",
    { category: z.enum(["auth","data","infra","messaging","ui","dev"]).optional().describe("optional category filter") },
    async ({ category }) => {
      const list = plugins.filter((p) => !category || p.category === category);
      const body = list.map((p) => `- **${p.name}** (${p.category})${p.stars ? ` ★${p.stars}` : ""}: ${p.description || "—"}\n  install: \`${p.install}\`  ·  ${SITE}/plugins/${p.slug}`).join("\n");
      return { content: [{ type: "text", text: `# togo plugins (${list.length}${category ? ` · ${category}` : ""})\n\n${body}` }] };
    });

  server.tool("get_plugin", "Get a plugin's details and full README.",
    { slug: z.string().describe("plugin slug, e.g. 'auth' or 'cache-redis'") },
    async ({ slug }) => {
      const p = repos.find((r) => r.slug === slug);
      if (!p) return { content: [{ type: "text", text: `No repo "${slug}". Call list_plugins to see valid slugs.` }], isError: true };
      const doc = await fetchDoc(slug);
      return { content: [{ type: "text", text:
`# ${p.name} (${p.category})
${p.description || ""}
${p.install ? `\nInstall: \`${p.install}\`` : ""}
Docs ${SITE}/docs/${slug} · Repo https://github.com/togo-framework/${slug}

---

${doc || "(no README available)"}` }] };
    });

  server.tool("search_docs", "Search togo repos and docs by keyword.",
    { query: z.string().describe("keyword(s) to match against repo names + descriptions") },
    async ({ query }) => {
      const q = query.toLowerCase();
      const hits = repos.filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(q));
      const body = hits.length
        ? hits.map((r) => `- **${r.name}** (${r.kind}/${r.category}): ${r.description || "—"} → get_doc("${r.slug}") · ${SITE}/docs/${r.slug}`).join("\n")
        : "No matches. Try a broader term, or list_plugins / framework_overview.";
      return { content: [{ type: "text", text: `# Search "${query}" — ${hits.length} hit(s)\n\n${body}` }] };
    });

  server.tool("get_doc", "Fetch a repo's full README/documentation as Markdown.",
    { repo: z.string().describe("repo slug, e.g. 'cli', 'togo', 'ui'") },
    async ({ repo }) => {
      const doc = await fetchDoc(repo);
      return doc
        ? { content: [{ type: "text", text: doc }] }
        : { content: [{ type: "text", text: `No docs found for "${repo}". Call search_docs to find the right slug.` }], isError: true };
    });

  server.tool("submit_plugin", "Submit a new plugin to the togo marketplace. Returns a prefilled GitHub issue URL (the plugin-submission form).",
    { name: z.string(), repo_url: z.string().describe("GitHub URL of the plugin repo"), description: z.string(), category: z.string().optional() },
    async ({ name, repo_url, description, category }) => {
      const title = encodeURIComponent(`[plugin] ${name}`);
      const url = `https://github.com/togo-framework/togo/issues/new?template=plugin-submission.yml&labels=plugin-submission&title=${title}`;
      return { content: [{ type: "text", text:
`Open this URL to submit **${name}** — it opens the togo "plugin-submission" issue form (paste these in):

${url}

- Plugin name: ${name}
- Repository: ${repo_url}
- Category: ${category || "other"}
- Description: ${description}

(Or browse ${SITE}/plugins/submit, or https://github.com/togo-framework/togo/issues/new/choose → "Plugin submission".)` }] };
    });

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) =>
  res.type("html").send(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>togo MCP</title>` +
    `<body style="font-family:system-ui,sans-serif;background:#07090c;color:#e8eef2;max-width:640px;margin:80px auto;padding:0 24px;line-height:1.6">` +
    `<h1 style="color:#1FC7DC">togo MCP</h1>` +
    `<p>Public Model Context Protocol server for the <a style="color:#1FC7DC" href="https://to-go.dev">togo</a> framework.</p>` +
    `<p>Connect (Streamable HTTP): <code style="background:#141a21;padding:3px 7px;border-radius:5px">https://mcp.to-go.dev/mcp</code></p>` +
    `<p>Tools: <code>framework_overview</code>, <code>list_plugins</code>, <code>get_plugin</code>, <code>search_docs</code>, <code>get_doc</code>, <code>submit_plugin</code>.</p>` +
    `<p style="color:#8b97a3;font-size:14px">${repos.length} repos · ${plugins.length} plugins · <a style="color:#8b97a3" href="https://github.com/togo-framework/mcp-web">source</a></p></body>`
  )
);
app.get("/healthz", (_req, res) => res.json({ ok: true, repos: repos.length, plugins: plugins.length }));

// Stateless Streamable HTTP MCP endpoint: fresh server+transport per request.
app.post("/mcp", async (req, res) => {
  try {
    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e) }, id: null });
  }
});
const notAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Stateless server — use POST /mcp." }, id: null });
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, () => console.log(`togo MCP on :${PORT} (${repos.length} repos)`));
