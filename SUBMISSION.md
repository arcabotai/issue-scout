# Issue Scout — Submission

**Project name:** Issue Scout
**Tagline:** An AI agent that finds the best first issues in any GitHub repo and writes the fix plan for you.
**Track / problem statement:** Build for Your World
**Repo:** https://github.com/arcabotai/issue-scout
**Live demo:** https://issuescout.arca.computer (Cloudflare Worker, `worker/`)
**Built:** entirely during the hackathon, Nov 4, 2026.

## Description (~150 words)
Contributing to open source starts with a hard question: which of hundreds of open issues can a newcomer actually fix? Issue Scout answers it. Enter any `owner/name` GitHub repo and an agent built on Meta's Muse Spark fetches the open issues, scores each one 0–10 for newcomer-friendliness with a short reason, and picks the top three. Then it goes further than a single prompt: for each pick, the model decides to call tools: it browses the repository file tree, reads the README, and opens source files through the GitHub API, before writing a concrete plan with the files likely involved, step-by-step approach, and tests to add. A streaming progress log shows every agent step and tool call in a clean single-page UI. It helps new contributors get unstuck and helps maintainers grow their contributor base. It runs locally with one command (`./run.sh`).

## How Meta models are used
- **Muse Spark 1.3 (`muse-spark-1.3-contributor`)** through the Meta Model API Chat Completions endpoint (`https://api.meta.ai/v1/chat/completions`).
- Step 1: structured-JSON reasoning over a batch of issues to score and rank them.
- Step 2: multi-turn **tool calling** (`get_repo_tree`, `get_readme`, `read_file`): the model chooses which repo context to fetch, then synthesizes grounded fix plans. This is the agentic loop.

## 3-minute demo video script
| Time | Shot | Narration |
|---|---|---|
| 0:00–0:15 | Face/title card "Issue Scout", GitHub repo page with README line "built during the hackathon Nov 4 2026" | "Making your first open-source contribution is hard because you can't tell which issues are doable. I built Issue Scout during this hackathon to fix that." |
| 0:15–0:35 | Terminal: `export META_API_KEY=…; ./run.sh`, then browser opens localhost:8000 | "One command to run. FastAPI plus a single HTML page. Everything is powered by Muse Spark through Meta Model API." |
| 0:35–0:55 | Type `psf/requests` in the box, click Scout; progress log starts streaming | "I enter a repo. The agent fetches the open issues from GitHub and sends them to Muse Spark." |
| 0:55–1:25 | Scroll the ranked issue list with score badges and reasons | "Muse Spark scores every issue 0 to 10 for newcomer-friendliness and explains why: clear scope, reproducible, small change." |
| 1:25–2:15 | Zoom on the log showing `tool call: get_repo_tree`, `get_readme`, `read_file` for the first pick | "This is the agentic part. For each top pick, the model decides to call tools, browsing the file tree, reading the README, opening source files, before it writes anything." |
| 2:15–2:45 | Scroll through a fix plan: files involved, approach, tests | "Each plan names real files, gives step-by-step approach, and says which tests to add. A newcomer can start coding immediately." |
| 2:45–3:00 | Code view of `app.py` tool loop, then repo URL | "Built from scratch today: the scoring prompt, the tool loop, the streaming UI. Muse Spark's tool calling makes the multi-step agent simple. Thanks!" |
