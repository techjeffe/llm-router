# LLM Router Proxy

A lightweight OpenAI-compatible proxy for VS Code / Continue that prefers your local model first and only falls back to OpenRouter when the request looks like it actually needs a stronger hosted model.

This repo is now tuned around a setup like:

- Local: `qwen3-coder:30b` over Ollama
- Cloud fallback: any OpenRouter model you want
- Goal: keep fast, cheap coding turns local and only pay for harder asks

## Routing rules

| Request type | Backend | Default model |
|---|---|---|
| Tab autocomplete | Local Ollama | `qwen3-coder:30b` |
| Normal coding chat / edit | Local Ollama | `qwen3-coder:30b` |
| Tool or function calling | OpenRouter | `anthropic/claude-3.7-sonnet` |
| Prompt near local context budget | OpenRouter | `anthropic/claude-3.7-sonnet` |
| Clearly high-complexity asks | OpenRouter | `anthropic/claude-3.7-sonnet` |

“High-complexity” is intentionally biased toward asks like architecture/design trade-offs, repo-wide reviews, migrations, investigations, and similar prompts where you may want a stronger remote model even when the context still fits locally.

## Setup

### 1. Make sure Ollama is running

```bash
ollama pull qwen3-coder:30b
```

### 2. Start the router

```bash
OPENROUTER_API_KEY=sk-or-your-key-here node server.js
```

Useful env vars:

```bash
export OLLAMA_CHAT_MODEL=qwen3-coder:30b
export OLLAMA_AUTOCOMPLETE_MODEL=qwen3-coder:30b
export LOCAL_CONTEXT_WINDOW_TOKENS=81000
export LOCAL_CONTEXT_RESERVE_TOKENS=12000
export OPENROUTER_MODEL=anthropic/claude-3.7-sonnet
```

### 3. Copy the Continue config

```bash
cp config.yaml ~/.continue/config.yaml
```

### 4. Restart VS Code

Point Continue at the proxy and let the router decide.

## Verify it

```bash
curl http://localhost:5555/health
```

You should see log lines like:

```text
[18:12:01] fits local budget (4821 tok) -> local:qwen3-coder:30b
[18:12:09] high-complexity ask (architecture, planning) -> openrouter:anthropic/claude-3.7-sonnet
[18:12:31] prompt near local context limit (71344 tok >= 69000 tok budget) -> openrouter:anthropic/claude-3.7-sonnet
[18:12:40] autocomplete -> local -> local:qwen3-coder:30b
```

## Tuning

The most important knobs are:

- `LOCAL_CONTEXT_WINDOW_TOKENS`: your real usable context size
- `LOCAL_CONTEXT_RESERVE_TOKENS`: headroom to preserve for the reply
- `ROUTER_COMPLEXITY_THRESHOLD`: how easily prompts escalate to OpenRouter
- `ROUTER_COMPLEXITY_MAX_PROMPT_TOKENS`: only use complexity routing below this prompt size
- `OPENROUTER_MODEL`: your preferred hosted fallback

If you want the router to stay local more aggressively, increase `ROUTER_COMPLEXITY_THRESHOLD`.

If you want it to escalate more often for “hard asks,” decrease that threshold.
