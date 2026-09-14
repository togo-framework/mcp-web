// Public MCP server for togo — exposes docs, the plugin marketplace, and plugin
// submission to any MCP client/agent over Streamable HTTP (stateless).
//
// The plugin list is fetched LIVE from the GitHub org (cached ~10 min), so it is
// always current as plugins are added — no redeploy needed. A bundled snapshot
// (data/catalog.json) is used only as an offline fallback.
import express from "express";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const SITE = "https://to-go.dev";
const ORG = "togo-framework";
const __dirname = dirname(fileURLToPath(import.meta.url));

type Repo = {
  name: string; slug: string; description: string; language: string;
  stars: number; branch: string; kind: "core" | "plugin"; category: string; install: string | null;
};

// Non-plugin repos (the framework + tooling).
const CORE = new Set([
  "togo", "cli", "create-togo-app", "ui", "mcp", "mcp-web", "db",
  "plugin-template", ".github", "to-go.dev", "awesome-togo",
]);

const categorize = (n: string): string =>
  /^auth(-|$)/.test(n) || n === "plugin-auth-supabase" ? "auth" :
  /^db-|^storage|^search|^supabase$|^orm$/.test(n) ? "data" :
  /^cache|^queue|^worker|^realtime|^log$/.test(n) ? "infra" :
  /^mail|^notifications/.test(n) ? "messaging" :
  /^i18n$|^dashboard$/.test(n) ? "ui" :
  /^faker$|^testing$|^validation$/.test(n) ? "dev" : "other";

const toRepo = (name: string, description = "", language = "", stars = 0, branch = "main"): Repo => {
  const kind = CORE.has(name) ? "core" : "plugin";
  return {
    name, slug: name, description, language, stars, branch, kind,
    category: kind === "core" ? "core" : categorize(name),
    install: kind === "plugin" ? `togo install togo-framework/${name}` : null,
  };
};

// Offline fallback: the snapshot bundled at build time.
let fallbackRepos: Repo[] = [];
try {
  const snap = JSON.parse(readFileSync(join(__dirname, "../data/catalog.json"), "utf8")) as { repos: Repo[] };
  fallbackRepos = (snap.repos || []).map((r) => toRepo(r.name, r.description, r.language, r.stars, r.branch));
} catch { /* no snapshot — live fetch only */ }

// Live repo list, fetched from the GitHub org and cached.
let cache: { at: number; repos: Repo[] } | null = null;
const TTL = 10 * 60 * 1000;

async function getRepos(): Promise<Repo[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.repos;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "togo-mcp" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const byName = new Map<string, Repo>();
  try {
    for (let page = 1; page <= 5; page++) {
      const r = await fetch(`https://api.github.com/orgs/${ORG}/repos?per_page=100&type=public&sort=full_name&page=${page}`, {
        headers, signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) break;
      const arr = (await r.json()) as any[];
      if (!Array.isArray(arr) || arr.length === 0) break;
      for (const x of arr) {
        if (x.private || x.archived) continue;
        byName.set(x.name, toRepo(x.name, x.description || "", x.language || "", x.stargazers_count || 0, x.default_branch || "main"));
      }
      if (arr.length < 100) break;
    }
  } catch { /* network error — use whatever we collected / the fallback */ }
  let repos = [...byName.values()];
  if (repos.length === 0) repos = fallbackRepos; // offline → bundled snapshot
  repos.sort((a, b) => a.name.localeCompare(b.name));
  if (repos.length) cache = { at: Date.now(), repos };
  return repos;
}

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
    { name: "togo", version: "0.2.0" },
    { instructions: "togo is an open-source, API-first full-stack framework (Go + sqlc + Atlas + React) with a Laravel-artisan-grade CLI. Use these tools to read togo docs, browse the (live) plugin marketplace, and submit a plugin to it." }
  );

  server.tool("framework_overview", "What togo is, its stack, and how to start a project.", {}, async () => {
    const repos = await getRepos();
    const plugins = repos.filter((r) => r.kind === "plugin");
    return { content: [{ type: "text", text:
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

Site ${SITE} · Plugins ${SITE}/marketplace · GitHub https://github.com/togo-framework
${repos.length} repos · ${plugins.length} installable plugins (live).` }] };
  });

  server.tool("list_plugins", "List the togo plugin marketplace (installable capabilities, fetched live).",
    { category: z.enum(["auth", "data", "infra", "messaging", "ui", "dev"]).optional().describe("optional category filter") },
    async ({ category }) => {
      const repos = await getRepos();
      const list = repos.filter((p) => p.kind === "plugin" && (!category || p.category === category));
      const body = list.map((p) => `- **${p.name}** (${p.category})${p.stars ? ` ★${p.stars}` : ""}: ${p.description || "—"}\n  install: \`${p.install}\`  ·  ${SITE}/plugins/${p.slug}`).join("\n");
      return { content: [{ type: "text", text: `# togo plugins (${list.length}${category ? ` · ${category}` : ""})\n\n${body}` }] };
    });

  server.tool("get_plugin", "Get a plugin's details and full README.",
    { slug: z.string().describe("plugin slug, e.g. 'auth' or 'cache-redis'") },
    async ({ slug }) => {
      const repos = await getRepos();
      let p = repos.find((r) => r.slug === slug);
      // The repo may exist on GitHub but not yet be in a stale cache — verify live by README.
      if (!p) {
        const probe = await fetchDoc(slug);
        if (probe) p = toRepo(slug);
      }
      if (!p) return { content: [{ type: "text", text: `No repo "${slug}". Call list_plugins to see valid slugs.` }], isError: true };
      const doc = await fetchDoc(slug);
      return { content: [{ type: "text", text:
`# ${p.name} (${p.category})
${p.description || ""}
${p.install ? `\nInstall: \`${p.install}\`` : ""}
Docs ${SITE}/plugins/${slug} · Repo https://github.com/togo-framework/${slug}

---

${doc || "(no README available)"}` }] };
    });

  server.tool("search_docs", "Search togo repos and docs by keyword (live).",
    { query: z.string().describe("keyword(s) to match against repo names + descriptions") },
    async ({ query }) => {
      const repos = await getRepos();
      const q = query.toLowerCase();
      const hits = repos.filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(q));
      const body = hits.length
        ? hits.map((r) => `- **${r.name}** (${r.kind}/${r.category}): ${r.description || "—"} → get_doc("${r.slug}") · ${SITE}/plugins/${r.slug}`).join("\n")
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

(Or browse ${SITE}/marketplace/submit, or https://github.com/togo-framework/togo/issues/new/choose → "Plugin submission".)` }] };
    });

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", async (_req, res) => {
  const repos = await getRepos();
  const plugins = repos.filter((r) => r.kind === "plugin").length;
  res.type("html").send(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>togo MCP</title>` +
    `<body style="font-family:system-ui,sans-serif;background:#0B1429;color:#F0EBE1;max-width:640px;margin:80px auto;padding:0 24px;line-height:1.6">` +
    `<svg viewBox="0 0 100 100" width="48" height="48" role="img" aria-label="ToGO" shape-rendering="crispEdges"><rect x="8" y="29" width="21" height="21" fill="#F0EBE1"/><rect x="29" y="8" width="21" height="21" fill="#F0EBE1"/><rect x="29" y="50" width="21" height="21" fill="#F0EBE1"/><rect x="50" y="29" width="21" height="21" fill="#1F8A99"/><rect x="50" y="71" width="21" height="21" fill="#1F8A99"/><rect x="71" y="50" width="21" height="21" fill="#1F8A99"/></svg>` +
    `<h1 style="font-weight:500;margin-top:16px">togo MCP</h1>` +
    `<p>Public Model Context Protocol server for the <a style="color:#1F8A99" href="https://to-go.dev">togo</a> framework.</p>` +
    `<p>Connect (Streamable HTTP): <code style="background:#0E1A3C;border:1px solid #25355C;padding:3px 7px;border-radius:6px">https://mcp.to-go.dev/mcp</code></p>` +
    `<p>Tools: <code>framework_overview</code>, <code>list_plugins</code>, <code>get_plugin</code>, <code>search_docs</code>, <code>get_doc</code>, <code>submit_plugin</code>.</p>` +
    `<p style="color:#8A97B8;font-size:14px">${repos.length} repos · ${plugins} plugins (live) · <a style="color:#8A97B8" href="https://github.com/togo-framework/mcp-web">source</a></p></body>`
  );
});
app.get("/healthz", async (_req, res) => {
  const repos = await getRepos();
  res.json({ ok: true, repos: repos.length, plugins: repos.filter((r) => r.kind === "plugin").length, live: !!cache });
});

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
app.listen(PORT, () => console.log(`togo MCP on :${PORT} (live plugin list from github.com/${ORG})`));
