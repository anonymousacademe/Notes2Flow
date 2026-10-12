# OpenCode + OpenRouter: Low-Cost Multi-Agent Model Setup

*Prices from early October 2026, in USD per million tokens (input / output). Check them on OpenRouter before you commit.*

## Principle

Put your spending on the agents that make judgments: the **planner** and the **reviewer**. Use flash-tier models for the **coders**, because they use the most tokens.

## Models for each role

| Role | Main pick | Cheaper fallback | Why |
|---|---|---|---|
| Planner | Claude Sonnet 5.5 ($2 / $10) | DeepSeek V4 Pro (about $0.66 / $1.98 off-peak) | Runs once per feature and writes little output. A bad plan wastes far more downstream. |
| Project manager (main agent) | GLM 5.3 ($1.40 / $4.40) | GLM 5.3 Flash | Needs reliable tool calls and a long context to track the subagents. It coordinates more than it reasons. |
| Coders | GLM 5.3 Flash ($0.15 / $0.50) | DeepSeek V4.1 Flash ($0.15 / $0.60 off-peak); MiMo-V2.6-Flash ($0.14 / $0.28) for boilerplate | Most of the spend is here. If a task fails twice, move it up to GLM 5.3. |
| Bug review and fix | DeepSeek V4 Pro | GPT-6.1 Sol ($2 / $10) for hard bugs | Use a different model family from the coders, because a model tends to miss its own kinds of mistakes. |

## Design cautions

- **The project manager must verify with tests, not by reading the code.** Let it run your tests and linter, and only accept work that passes.
- **Consider merging the planner and the project manager** for small apps. Every extra handoff costs tokens and risks misreading. Keep them separate once a plan has more than about 5 parallel parts.
- **The planner defines what "done" means.** It writes acceptance tests or criteria for each part. The coders and the debugger work against those.

## OpenCode config sketch (`opencode.json`)

Check every model ID on OpenRouter. Only the two GLM IDs are confirmed.

```json
{
  "agent": {
    "pm": {
      "mode": "primary",
      "model": "openrouter/z-ai/glm-5.3",
      "prompt": "{file:./prompts/pm.md}",
      "permission": {
        "edit": "deny",
        "bash": { "*": "ask", "pytest*": "allow", "python -m pytest*": "allow", "make test*": "allow" }
      }
    },
    "planner": {
      "mode": "subagent",
      "description": "Breaks a feature into parts with acceptance tests",
      "model": "openrouter/<sonnet-5.5-slug>",
      "permission": { "edit": "deny" }
    },
    "coder": {
      "mode": "subagent",
      "description": "Implements one scoped part of the plan",
      "model": "openrouter/z-ai/glm-5.3-flash"
    },
    "debugger": {
      "mode": "subagent",
      "description": "Reviews diffs for bugs and fixes failing tests",
      "model": "openrouter/<deepseek-v4-pro-slug>"
    }
  }
}
```

Notes:

- You can also write agents as markdown files in `.opencode/agents/`: settings go in the frontmatter, and the file body is the prompt.
- A subagent with no `model` set uses the model of the agent that called it.
- The `permission.task` setting controls which subagents the project manager can call.
- The `{file:./prompts/pm.md}` reference resolves relative to the config file that contains it. Create `prompts/pm.md` before enabling the `pm` agent, or replace the value with an inline prompt string — a missing file yields an empty/broken prompt, not an error.

## On this machine (Windows)

- OpenCode's user-level config here is `C:\Users\user\.config\opencode\opencode.jsonc` (JSONC, not `.json`). It currently defines only an Ollama provider and has no `agent` block. To use this setup, either add the `agent` block above to that file, or create a project-level `opencode.json` in the repo (project config overrides user config per key).
- OpenRouter must be authenticated before any `openrouter/...` model resolves: run `opencode auth login`, pick OpenRouter, and paste the key (it is stored by opencode; never put the key in the config file).
- Shell is **Windows PowerShell 5.1**, not bash. Permission patterns are matched against the command string as issued, so allow-list what will actually be typed: `pytest*`, `python -m pytest*`, and `make test*` (make runs under its own shell on Windows only if GNU make is installed; otherwise the PM should call the venv directly).
- In this repo the venv interpreter is `.venv\Scripts\python.exe` on Windows (the repo's Makefile and docs use the Linux form `.venv/bin/python`; the Makefile, `tools/capped.sh`, `tools/hwcheck.py` and `tools/peakmem.py` assume Linux and will not run natively on this machine). The PM's verification command on this machine is:
  `& ".venv\Scripts\python.exe" -m pytest` — consider allowing `*python.exe" -m pytest*` in `permission.bash` if the PM calls it that way.
- `npm test*` was dropped from the allow-list above because nothing in this workspace runs under npm.

## Cost tips

- DeepSeek has off-peak pricing, and batch versions of models run at about half price. Use them for overnight or unattended runs.
- Sources disagree on GLM 5.3 Flash's input price: OpenRouter's compare page shows $0.04, while a ranking site lists $0.15. Prices also differ by provider, so check the provider you're actually routed to.

## Sources

- [OpenRouter Top Models (Oct 2026)](https://www.teamday.ai/blog/top-ai-models-openrouter-2026)
- [OpenRouter: GLM 5.3 vs 5.3 Flash](https://openrouter.ai/compare/z-ai/glm-5.3/z-ai/glm-5.3-flash)
- [OpenCode agents docs](https://opencode.ai/docs/agents/)
- [OpenCode and the multi-model stack](https://medium.com/@coductor/opencode-and-the-multi-model-stack-route-tasks-to-the-model-best-for-each-d72970aa30b6)
- [Regolo: OpenCode multi-agent cost optimization](https://regolo.ai/opencode-brick-for-multi-agent-coding-and-optimize-costs-up-to-80/)
