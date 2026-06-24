// Build-time: snapshot the togo-framework repos (gh) into data/catalog.json.
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
const sh = (c) => execSync(c, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const CORE = new Set(["togo","cli","create-togo-app","ui","mcp","mcp-web","db","plugin-template",".github","to-go.dev"]);
const categorize = (n) =>
  /^auth(-|$)/.test(n) || n === "plugin-auth-supabase" ? "auth" :
  /^db-|^storage|^search|^supabase$|^orm$/.test(n) ? "data" :
  /^cache|^queue|^worker|^realtime|^log$/.test(n) ? "infra" :
  /^mail|^notifications/.test(n) ? "messaging" :
  /^i18n$|^dashboard$/.test(n) ? "ui" :
  /^faker$|^testing$|^validation$/.test(n) ? "dev" : "other";
const raw = sh(`gh repo list togo-framework --limit 200 --no-archived --json name,description,primaryLanguage,stargazerCount,defaultBranchRef,isPrivate`);
const repos = JSON.parse(raw).filter((r) => !r.isPrivate).map((r) => {
  const kind = CORE.has(r.name) ? "core" : "plugin";
  return { name: r.name, slug: r.name, description: r.description || "", language: r.primaryLanguage?.name || "",
    stars: r.stargazerCount || 0, branch: r.defaultBranchRef?.name || "main",
    kind, category: kind === "core" ? "core" : categorize(r.name),
    install: kind === "plugin" ? `togo install togo-framework/${r.name}` : null };
}).sort((a, b) => a.name.localeCompare(b.name));
mkdirSync("data", { recursive: true });
writeFileSync("data/catalog.json", JSON.stringify({ repos }, null, 2));
console.log(`catalog: ${repos.length} repos (${repos.filter(r=>r.kind==="plugin").length} plugins)`);
