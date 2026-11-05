import { INDEX_HTML } from "./html";

interface Env { META_API_KEY: string; GITHUB_TOKEN?: string; META_BASE_URL?: string; META_MODEL?: string; SCOUT_ENABLED?: string; }
const MAX_ISSUES = 20;

const TOOLS = [
  { type: "function", function: { name: "get_repo_tree", description: "List file paths in the repository (top-level or under a directory path).", parameters: { type: "object", properties: { path: { type: "string", description: "optional directory prefix, e.g. 'src/requests'" } } } } },
  { type: "function", function: { name: "get_readme", description: "Fetch the repository README (truncated).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read_file", description: "Read a source file from the repo (truncated to 3000 chars).", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];

async function gh(env: Env, path: string, params?: Record<string, string | number>): Promise<any> {
  const u = new URL("https://api.github.com" + path);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v));
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "issue-scout" };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const r = await fetch(u.toString(), { headers });
  if (!r.ok) throw new Error(`GitHub API ${r.status} for ${path}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function b64decode(s: string): string {
  const bin = atob(s.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function chat(env: Env, messages: any[], tools: any[] | null = null, maxTokens = 2500): Promise<any> {
  const model = env.META_MODEL || "muse-spark-1.3-contributor";
  const base = env.META_BASE_URL || "https://api.meta.ai/v1";
  const body: any = { model, messages, max_tokens: maxTokens, reasoning_effort: "low" };
  if (tools) body.tools = tools;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.META_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 400) {
      const msg = await r.text();
      if ("reasoning_effort" in body && msg.includes("reasoning")) { delete body.reasoning_effort; continue; }
      if ("max_tokens" in body && msg.includes("max_tokens") && msg.includes("max_completion_tokens")) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; continue; }
      throw new Error(`Meta API 400: ${msg.slice(0, 400)}`);
    }
    if (!r.ok) throw new Error(`Meta API ${r.status}: ${(await r.text()).slice(0, 400)}`);
    const j: any = await r.json();
    return j.choices[0].message;
  }
  throw new Error("Meta API request failed");
}

function parseJson(text: string | null | undefined): any {
  const m = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(text || "");
  return m ? JSON.parse(m[0]) : null;
}

async function runTool(env: Env, repo: string, name: string, args: any, ctx: { tree?: string[] }): Promise<string> {
  if (name === "get_repo_tree") {
    if (!ctx.tree) {
      const info = await gh(env, `/repos/${repo}`);
      const t = await gh(env, `/repos/${repo}/git/trees/${info.default_branch}`, { recursive: "1" });
      ctx.tree = (t.tree || []).filter((x: any) => x.type === "blob").map((x: any) => x.path);
    }
    const pre = String(args.path || "").trim().replace(/^\/+|\/+$/g, "");
    let paths = pre ? ctx.tree.filter((p) => p.startsWith(pre)) : ctx.tree;
    if (!pre || paths.length > 150) {
      const seen = new Set<string>(); const out: string[] = [];
      for (const p of paths) {
        const parts = p.slice(pre.length).replace(/^\/+/, "").split("/");
        const item = (pre ? pre + "/" : "") + parts[0] + (parts.length > 1 ? "/" : "");
        if (!seen.has(item)) { seen.add(item); out.push(item); }
      }
      paths = out;
    }
    return paths.slice(0, 150).join("\n") || "(no matches)";
  }
  if (name === "get_readme") {
    const d = await gh(env, `/repos/${repo}/readme`);
    return b64decode(d.content).slice(0, 3000);
  }
  if (name === "read_file") {
    const d = await gh(env, `/repos/${repo}/contents/${args.path || ""}`);
    return b64decode(d.content).slice(0, 3000);
  }
  return "unknown tool";
}

async function scout(env: Env, repo: string, emit: (type: string, data?: any) => Promise<void>) {
  const log = (message: string) => emit("log", { message });
  if (!env.META_API_KEY) { await emit("error", { message: "META_API_KEY is not set on the server." }); return; }
  try {
    const model = env.META_MODEL || "muse-spark-1.3-contributor";
    await log(`Step 1/4: fetching open issues for ${repo} from the GitHub API…`);
    const raw: any[] = await gh(env, `/repos/${repo}/issues`, { state: "open", per_page: 50, sort: "updated" });
    const issues = raw.filter((i) => !("pull_request" in i)).slice(0, MAX_ISSUES);
    if (!issues.length) { await emit("error", { message: "No open issues found." }); return; }
    await log(`Got ${issues.length} open issues. Sending to Muse Spark (${model}) for newcomer-friendliness scoring…`);
    const compact = issues.map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((l: any) => l.name), comments: i.comments, body: (i.body || "").slice(0, 500) }));
    const msg = await chat(env, [
      { role: "system", content: "You triage GitHub issues for first-time contributors. Reply with JSON only." },
      { role: "user", content: 'Score each issue 0-10 for newcomer-friendliness (clear scope, small change, reproducible, no deep design debate). Return JSON: {"scores":[{"number":int,"score":int,"reason":"one sentence"}],"top3":[issue numbers]}.\n\nIssues:\n' + JSON.stringify(compact) },
    ], null, 3500);
    const data = parseJson(msg.content) || {};
    const byNum = new Map<number, any>(issues.map((i) => [i.number, i]));
    const scores = (data.scores || []).filter((s: any) => byNum.has(s.number)).sort((a: any, b: any) => (b.score || 0) - (a.score || 0));
    for (const s of scores) { s.title = byNum.get(s.number).title; s.url = byNum.get(s.number).html_url; }
    await emit("scores", { scores });
    let top: number[] = (data.top3 || []).filter((n: number) => byNum.has(n)).slice(0, 3);
    if (!top.length) top = scores.slice(0, 3).map((s: any) => s.number);
    await log(`Step 2/4: Muse Spark picked top ${top.length}: ` + top.map((n) => `#${n}`).join(", "));
    const ctx: { tree?: string[] } = {};
    for (const n of top) {
      const iss = byNum.get(n);
      await log(`Step 3/4: agent investigating #${n} — ${iss.title.slice(0, 70)}`);
      const messages: any[] = [
        { role: "system", content: "You are a senior maintainer helping a newcomer fix a GitHub issue. First use the tools (get_repo_tree, get_readme, read_file) to ground yourself in the real repo layout, then write a concrete plan in Markdown with sections: **Files likely involved** (real paths), **Approach** (numbered steps), **Tests**. Be concise (under 250 words)." },
        { role: "user", content: `Repo: ${repo}\nIssue #${n}: ${iss.title}\n\n${(iss.body || "").slice(0, 1500)}` },
      ];
      let plan: string | null = null;
      for (let step = 0; step < 5; step++) {
        const m = await chat(env, messages, step < 4 ? TOOLS : null, 2500);
        const calls = m.tool_calls || [];
        if (!calls.length) { plan = m.content; break; }
        messages.push({ role: m.role, content: m.content || "", tool_calls: m.tool_calls });
        for (const c of calls) {
          const fn = c.function.name;
          let a: any = {};
          try { a = JSON.parse(c.function.arguments || "{}"); } catch { a = {}; }
          await log(`   ↳ tool call: ${fn}(${JSON.stringify(a)})`);
          let out: string;
          try { out = await runTool(env, repo, fn, a, ctx); } catch (e: any) { out = `error: ${e.message || e}`; }
          messages.push({ role: "tool", tool_call_id: c.id, content: out });
        }
      }
      await emit("plan", { number: n, title: iss.title, url: iss.html_url, plan: plan || "(no plan returned)" });
    }
    await log("Step 4/4: done.");
    await emit("done");
  } catch (e: any) {
    await emit("error", { message: String(e.message || e) });
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/scout") {
      const enc = new TextEncoder();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const emit = async (type: string, data: any = {}) => { await writer.write(enc.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`)); };
      let repo = (url.searchParams.get("repo") || "").trim().replace(/^https:\/\/github\.com\//, "").replace(/^\/+|\/+$/g, "");
      const headers = { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" };
      if (env.SCOUT_ENABLED !== "true") {
        ctx.waitUntil((async () => { await emit("error", { message: "Live scouting is paused after the hackathon. See github.com/arcabotai/issue-scout to run it yourself." }); await writer.close(); })());
        return new Response(readable, { headers });
      }
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        ctx.waitUntil((async () => { await emit("error", { message: "Use owner/name format." }); await writer.close(); })());
        return new Response(readable, { headers });
      }
      ctx.waitUntil((async () => { try { await scout(env, repo, emit); } finally { try { await writer.close(); } catch {} } })());
      return new Response(readable, { headers });
    }
    return new Response("Not found", { status: 404 });
  },
};
