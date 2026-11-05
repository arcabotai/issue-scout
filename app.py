"""Issue Scout - agentic GitHub issue triage powered by Meta's Muse Spark (Meta Model API)."""
import json, os, re, subprocess, base64
import requests
from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, StreamingResponse

META_BASE = os.environ.get("META_BASE_URL", "https://api.meta.ai/v1")
MODEL = os.environ.get("META_MODEL", "muse-spark-1.3-contributor")
MAX_ISSUES = 20
app = FastAPI()


def meta_key():
    return os.environ.get("META_API_KEY") or os.environ.get("MODEL_API_KEY")


def gh_headers():
    h = {"Accept": "application/vnd.github+json", "User-Agent": "issue-scout"}
    tok = os.environ.get("GITHUB_TOKEN")
    if not tok:
        try:
            tok = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:
            tok = ""
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


def gh(path, params=None, raw=False):
    r = requests.get(f"https://api.github.com{path}", headers=gh_headers(), params=params, timeout=30)
    r.raise_for_status()
    return r.json()


# ---------- Meta Model API (Chat Completions, OpenAI-compatible) ----------
def chat(messages, tools=None, max_tokens=2500):
    body = {"model": MODEL, "messages": messages, "max_tokens": max_tokens, "reasoning_effort": "low"}
    if tools:
        body["tools"] = tools
    for _ in range(3):
        r = requests.post(f"{META_BASE}/chat/completions", json=body, timeout=120,
                          headers={"Authorization": f"Bearer {meta_key()}", "Content-Type": "application/json"})
        if r.status_code == 400:  # drop an unsupported optional param and retry
            msg = r.text
            if "reasoning_effort" in body and "reasoning" in msg:
                body.pop("reasoning_effort"); continue
            if "max_tokens" in body and "max_tokens" in msg and "max_completion_tokens" in msg:
                body["max_completion_tokens"] = body.pop("max_tokens"); continue
        if r.status_code >= 400:
            raise RuntimeError(f"Meta API {r.status_code}: {r.text[:400]}")
        return r.json()["choices"][0]["message"]
    raise RuntimeError("Meta API request failed")


def parse_json(text):
    m = re.search(r"\{.*\}|\[.*\]", text or "", re.S)
    return json.loads(m.group(0)) if m else None


# ---------- Tools the model can call ----------
TOOLS = [
    {"type": "function", "function": {"name": "get_repo_tree",
        "description": "List file paths in the repository (top-level or under a directory path).",
        "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "optional directory prefix, e.g. 'src/requests'"}}}}},
    {"type": "function", "function": {"name": "get_readme",
        "description": "Fetch the repository README (truncated).",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "read_file",
        "description": "Read a source file from the repo (truncated to 3000 chars).",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
]


def run_tool(repo, name, args, ctx):
    if name == "get_repo_tree":
        if "tree" not in ctx:
            info = gh(f"/repos/{repo}")
            ctx["tree"] = [t["path"] for t in gh(f"/repos/{repo}/git/trees/{info['default_branch']}", {"recursive": "1"}).get("tree", []) if t["type"] == "blob"]
        pre = (args.get("path") or "").strip("/")
        paths = [p for p in ctx["tree"] if p.startswith(pre)] if pre else ctx["tree"]
        if not pre or len(paths) > 150:  # keep it small: top-level dirs + files
            seen, out = set(), []
            for p in paths:
                parts = p[len(pre):].lstrip("/").split("/")
                item = (pre + "/" if pre else "") + parts[0] + ("/" if len(parts) > 1 else "")
                if item not in seen:
                    seen.add(item); out.append(item)
            paths = out
        return "\n".join(paths[:150]) or "(no matches)"
    if name == "get_readme":
        d = gh(f"/repos/{repo}/readme")
        return base64.b64decode(d["content"]).decode("utf-8", "replace")[:3000]
    if name == "read_file":
        d = gh(f"/repos/{repo}/contents/{args.get('path','')}")
        return base64.b64decode(d["content"]).decode("utf-8", "replace")[:3000]
    return "unknown tool"


# ---------- Agent ----------
def ev(type_, **kw):
    return f"data: {json.dumps({'type': type_, **kw})}\n\n"


def scout(repo):
    if not meta_key():
        yield ev("error", message="META_API_KEY is not set on the server."); return
    try:
        yield ev("log", message=f"Step 1/4: fetching open issues for {repo} from the GitHub API…")
        raw = gh(f"/repos/{repo}/issues", {"state": "open", "per_page": 50, "sort": "updated"})
        issues = [i for i in raw if "pull_request" not in i][:MAX_ISSUES]
        if not issues:
            yield ev("error", message="No open issues found."); return
        yield ev("log", message=f"Got {len(issues)} open issues. Sending to Muse Spark ({MODEL}) for newcomer-friendliness scoring…")
        compact = [{"number": i["number"], "title": i["title"], "labels": [l["name"] for l in i["labels"]],
                    "comments": i["comments"], "body": (i["body"] or "")[:500]} for i in issues]
        msg = chat([
            {"role": "system", "content": "You triage GitHub issues for first-time contributors. Reply with JSON only."},
            {"role": "user", "content": 'Score each issue 0-10 for newcomer-friendliness (clear scope, small change, reproducible, no deep design debate). '
             'Return JSON: {"scores":[{"number":int,"score":int,"reason":"one sentence"}],"top3":[issue numbers]}.\n\nIssues:\n' + json.dumps(compact)}
        ], max_tokens=3500)
        data = parse_json(msg.get("content")) or {}
        by_num = {i["number"]: i for i in issues}
        scores = sorted([s for s in data.get("scores", []) if s.get("number") in by_num], key=lambda s: -s.get("score", 0))
        for s in scores:
            s["title"] = by_num[s["number"]]["title"]; s["url"] = by_num[s["number"]]["html_url"]
        yield ev("scores", scores=scores)
        top = [n for n in data.get("top3", []) if n in by_num][:3] or [s["number"] for s in scores[:3]]
        yield ev("log", message=f"Step 2/4: Muse Spark picked top {len(top)}: " + ", ".join(f"#{n}" for n in top))
        ctx = {}
        for n in top:
            iss = by_num[n]
            yield ev("log", message=f"Step 3/4: agent investigating #{n} — {iss['title'][:70]}")
            messages = [
                {"role": "system", "content": "You are a senior maintainer helping a newcomer fix a GitHub issue. First use the tools (get_repo_tree, get_readme, read_file) to ground yourself in the real repo layout, then write a concrete plan in Markdown with sections: **Files likely involved** (real paths), **Approach** (numbered steps), **Tests**. Be concise (under 250 words)."},
                {"role": "user", "content": f"Repo: {repo}\nIssue #{n}: {iss['title']}\n\n{(iss['body'] or '')[:1500]}"},
            ]
            plan = None
            for step in range(5):
                m = chat(messages, tools=TOOLS if step < 4 else None, max_tokens=2500)
                calls = m.get("tool_calls") or []
                if not calls:
                    plan = m.get("content"); break
                messages.append({k: v for k, v in m.items() if k in ("role", "content", "tool_calls")} | {"content": m.get("content") or ""})
                for c in calls:
                    fn = c["function"]["name"]
                    try:
                        a = json.loads(c["function"].get("arguments") or "{}")
                    except Exception:
                        a = {}
                    yield ev("log", message=f"   ↳ tool call: {fn}({json.dumps(a)})")
                    try:
                        out = run_tool(repo, fn, a, ctx)
                    except Exception as e:
                        out = f"error: {e}"
                    messages.append({"role": "tool", "tool_call_id": c["id"], "content": out})
            yield ev("plan", number=n, title=iss["title"], url=iss["html_url"], plan=plan or "(no plan returned)")
        yield ev("log", message="Step 4/4: done.")
        yield ev("done")
    except Exception as e:
        yield ev("error", message=str(e))


@app.get("/api/scout")
def api_scout(repo: str = Query(...)):
    repo = repo.strip().removeprefix("https://github.com/").strip("/")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        return StreamingResponse(iter([ev("error", message="Use owner/name format.")]), media_type="text/event-stream")
    return StreamingResponse(scout(repo), media_type="text/event-stream")


@app.get("/")
def index():
    return FileResponse(os.path.join(os.path.dirname(__file__), "index.html"))
