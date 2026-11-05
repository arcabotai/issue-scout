# 🔭 Issue Scout

> **Everything in this repository was built during the Meta Global AI Developer Hackathon on Nov 4, 2026.**

**Problem statement:** *Build for Your World.* Open-source maintainers and first-time contributors both lose hours to issue triage: which of 300 open issues is actually doable for a newcomer, and where do I even start? Issue Scout is the tool I wished I had when making my first contribution.

## What it does
Enter a GitHub repo (`owner/name`). An agent powered by Meta's **Muse Spark** model:
1. Fetches open issues via the GitHub REST API.
2. **Scores each issue (0–10) for newcomer-friendliness**, with a one-line reason.
3. **Picks the top 3.**
4. For each pick, runs a **tool-calling loop**: the model decides to call `get_repo_tree`, `get_readme`, and `read_file` (GitHub API) to ground itself in the real repo, then writes a concrete fix plan: files likely involved, step-by-step approach, and tests.

The UI streams an agent progress log (including every tool call) and renders ranked issues and plans.

## Meta models / APIs used
- **Muse Spark 1.3** (`muse-spark-1.3`) via **Meta Model API** — `POST https://api.meta.ai/v1/chat/completions` (OpenAI-compatible Chat Completions, `Authorization: Bearer $META_API_KEY`).
- Used for (a) structured JSON scoring/ranking of issues and (b) multi-step **function/tool calling** for the plan-writing agent. Small `max_tokens` and low reasoning effort keep cost low.

## Run it
```bash
export META_API_KEY=your-key      # or put it in .env (git-ignored)
./run.sh                          # installs deps in a venv, serves http://localhost:8000
```
Optional: `GITHUB_TOKEN` (or a logged-in `gh` CLI) raises GitHub rate limits. Override model with `META_MODEL`.

Stack: Python FastAPI + one static HTML page (server-sent events for streaming). Files: `app.py`, `index.html`.

## Example
See [`examples/`](examples/) for sample output (if present).
