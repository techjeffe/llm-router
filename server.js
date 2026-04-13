/**
 * LLM Router Proxy
 *
 * Sits between VS Code / Continue and your model backends.
 * Speaks OpenAI-compatible API format on all sides.
 *
 * Routing defaults:
 *   - Autocomplete requests -> local Ollama
 *   - Typical coding chat/edit -> local Ollama
 *   - Tool / function calling -> OpenRouter
 *   - Long context or clearly high-complexity asks -> OpenRouter
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... node server.js
 */

const http = require("http");
const https = require("https");

const CONFIG = {
  port: Number(process.env.PORT || 5555),

  local: {
    host: process.env.OLLAMA_HOST || "127.0.0.1",
    port: Number(process.env.OLLAMA_PORT || 11434),
    chatModel: process.env.OLLAMA_CHAT_MODEL || "qwen3-coder:30b",
    autocompleteModel: process.env.OLLAMA_AUTOCOMPLETE_MODEL || "qwen3-coder:30b",
    contextWindowTokens: Number(process.env.LOCAL_CONTEXT_WINDOW_TOKENS || 81000),
  },

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || "",
    model: process.env.OPENROUTER_MODEL || "anthropic/claude-3.7-sonnet",
    host: process.env.OPENROUTER_HOST || "openrouter.ai",
    path: process.env.OPENROUTER_PATH || "/api/v1/chat/completions",
    maxTokens: Number(process.env.OPENROUTER_MAX_TOKENS || 8192),
    referer: process.env.OPENROUTER_HTTP_REFERER || "",
    title: process.env.OPENROUTER_X_TITLE || "llm-router",
  },

  routing: {
    localContextReserveTokens: Number(process.env.LOCAL_CONTEXT_RESERVE_TOKENS || 12000),
    complexityKeywordScoreThreshold: Number(process.env.ROUTER_COMPLEXITY_THRESHOLD || 4),
    complexityMaxPromptTokens: Number(process.env.ROUTER_COMPLEXITY_MAX_PROMPT_TOKENS || 24000),
  },
};

function estimateTokens(value) {
  if (typeof value === "number") {
    return Math.ceil(value / 4);
  }

  if (typeof value === "string") {
    return Math.ceil(value.length / 4);
  }

  return 0;
}

function stringifyContent(content) {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "input_text") return part.text || "";
      if (part.type === "image_url") return "[image]";
      if (part.type === "input_image") return "[image]";
      if (part.type === "tool_result") return JSON.stringify(part.content || "");
      return JSON.stringify(part);
    }).join("\n");
  }

  if (content && typeof content === "object") {
    return JSON.stringify(content);
  }

  return "";
}

function getTotalPromptChars(messages) {
  if (!Array.isArray(messages)) return 0;

  return messages.reduce((sum, msg) => {
    return sum + stringifyContent(msg.content).length;
  }, 0);
}

function getLastUserMessage(messages) {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      return stringifyContent(messages[i].content);
    }
  }

  return "";
}

function hasToolUse(body) {
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  if (Array.isArray(body.functions) && body.functions.length > 0) return true;
  if (body.tool_choice && body.tool_choice !== "none") return true;
  if (body.function_call && body.function_call !== "none") return true;
  return false;
}

function isAutocompleteRequest(body) {
  return body._isAutocomplete === true;
}

function getLocalPromptBudgetTokens() {
  return Math.max(
    1024,
    CONFIG.local.contextWindowTokens - CONFIG.routing.localContextReserveTokens
  );
}

function scoreComplexity(text) {
  const lower = text.toLowerCase();
  const matched = [];
  let score = 0;

  const weightedPatterns = [
    { regex: /\btool(?:s| use| calling)?\b/, score: 3, label: "tooling" },
    { regex: /\bagent(?:ic)?\b/, score: 3, label: "agentic" },
    { regex: /\barchitecture\b|\bdesign\b|\btrade-?off\b/, score: 2, label: "architecture" },
    { regex: /\breview\b|\baudit\b|\bsecurity\b/, score: 2, label: "review" },
    { regex: /\bmigrate\b|\brefactor\b|\brewrite\b/, score: 2, label: "migration" },
    { regex: /\bcompare\b|\bevaluate\b|\bchoose\b|\brecommend\b/, score: 2, label: "selection" },
    { regex: /\bdebug\b|\binvestigate\b|\broot cause\b/, score: 2, label: "investigation" },
    { regex: /\bwhole\b|\bentire\b|\bacross the codebase\b|\brepo\b/, score: 2, label: "large-scope" },
    { regex: /\bplan\b|\bstrategy\b|\bapproach\b/, score: 1, label: "planning" },
  ];

  for (const pattern of weightedPatterns) {
    if (pattern.regex.test(lower)) {
      score += pattern.score;
      matched.push(pattern.label);
    }
  }

  return { score, matched };
}

function decideBackend(body) {
  if (isAutocompleteRequest(body)) {
    return {
      backend: "local",
      model: CONFIG.local.autocompleteModel,
      reason: "autocomplete -> local",
    };
  }

  if (hasToolUse(body)) {
    return {
      backend: "openrouter",
      model: CONFIG.openrouter.model,
      reason: "tool use detected -> OpenRouter",
    };
  }

  const promptChars = getTotalPromptChars(body.messages);
  const promptTokens = estimateTokens(promptChars);
  const localBudgetTokens = getLocalPromptBudgetTokens();

  if (promptTokens >= localBudgetTokens) {
    return {
      backend: "openrouter",
      model: CONFIG.openrouter.model,
      reason: `prompt near local context limit (${promptTokens} tok >= ${localBudgetTokens} tok budget) -> OpenRouter`,
    };
  }

  const lastUserMessage = getLastUserMessage(body.messages);
  const complexity = scoreComplexity(lastUserMessage);
  if (
    complexity.score >= CONFIG.routing.complexityKeywordScoreThreshold &&
    promptTokens <= CONFIG.routing.complexityMaxPromptTokens
  ) {
    return {
      backend: "openrouter",
      model: CONFIG.openrouter.model,
      reason: `high-complexity ask (${complexity.matched.join(", ")}) -> OpenRouter`,
    };
  }

  return {
    backend: "local",
    model: CONFIG.local.chatModel,
    reason: `fits local budget (${promptTokens} tok) -> local`,
  };
}

function collectRequestBody(req, callback) {
  let rawBody = "";
  req.on("data", (chunk) => {
    rawBody += chunk;
  });
  req.on("end", () => {
    try {
      callback(null, JSON.parse(rawBody || "{}"));
    } catch {
      callback(new Error("Invalid JSON"));
    }
  });
}

function writeProxyError(res, statusCode, message) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message } }));
}

function proxyToLocal(body, isCompletion, res) {
  const path = isCompletion ? "/v1/completions" : "/v1/chat/completions";
  const cleanBody = { ...body };
  delete cleanBody._isAutocomplete;

  const payload = JSON.stringify(cleanBody);
  const options = {
    hostname: CONFIG.local.host,
    port: CONFIG.local.port,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error("[local error]", err.message);
    writeProxyError(res, 502, `Local backend unavailable: ${err.message}`);
  });

  proxyReq.write(payload);
  proxyReq.end();
}

function proxyToOpenRouter(body, res) {
  const cleanBody = { ...body };
  delete cleanBody._isAutocomplete;

  const payloadBody = {
    ...cleanBody,
    model: CONFIG.openrouter.model,
    max_tokens:
      cleanBody.max_tokens ||
      cleanBody.max_completion_tokens ||
      CONFIG.openrouter.maxTokens,
  };

  delete payloadBody.max_completion_tokens;

  const payload = JSON.stringify(payloadBody);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${CONFIG.openrouter.apiKey}`,
    "Content-Length": Buffer.byteLength(payload),
  };

  if (CONFIG.openrouter.referer) {
    headers["HTTP-Referer"] = CONFIG.openrouter.referer;
  }

  if (CONFIG.openrouter.title) {
    headers["X-Title"] = CONFIG.openrouter.title;
  }

  const options = {
    hostname: CONFIG.openrouter.host,
    port: 443,
    path: CONFIG.openrouter.path,
    method: "POST",
    headers,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error("[openrouter error]", err.message);
    writeProxyError(res, 502, `OpenRouter backend unavailable: ${err.message}`);
  });

  proxyReq.write(payload);
  proxyReq.end();
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      config: {
        localChat: CONFIG.local.chatModel,
        localAutocomplete: CONFIG.local.autocompleteModel,
        openrouterModel: CONFIG.openrouter.model,
        localContextWindowTokens: CONFIG.local.contextWindowTokens,
        localPromptBudgetTokens: getLocalPromptBudgetTokens(),
      },
    }));
    return;
  }

  if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "llm-router", object: "model", owned_by: "local-proxy" },
        { id: "llm-router-autocomplete", object: "model", owned_by: "local-proxy" },
      ],
    }));
    return;
  }

  const isChatCompletion = req.url === "/v1/chat/completions" || req.url === "/chat/completions";
  const isCompletion = req.url === "/v1/completions" || req.url === "/completions";

  if (req.method !== "POST" || (!isChatCompletion && !isCompletion)) {
    writeProxyError(res, 404, "Not found");
    return;
  }

  collectRequestBody(req, (err, body) => {
    if (err) {
      writeProxyError(res, 400, err.message);
      return;
    }

    if (isCompletion) {
      body._isAutocomplete = true;
    }

    const decision = decideBackend(body);
    const timestamp = new Date().toISOString().slice(11, 19);
    console.log(`[${timestamp}] ${decision.reason} -> ${decision.backend}:${decision.model}`);

    body.model = decision.model;

    if (decision.backend === "local") {
      proxyToLocal(body, isCompletion, res);
      return;
    }

    if (!CONFIG.openrouter.apiKey) {
      writeProxyError(res, 500, "OPENROUTER_API_KEY is not set");
      return;
    }

    proxyToOpenRouter(body, res);
  });
});

if (!CONFIG.openrouter.apiKey) {
  console.warn("No OPENROUTER_API_KEY set. OpenRouter routing will fail.");
}

server.listen(CONFIG.port, () => {
  console.log(`
┌────────────────────────────────────────────────────────┐
│                 LLM Router Proxy                      │
├────────────────────────────────────────────────────────┤
│ Listening:    http://localhost:${String(CONFIG.port).padEnd(18)}│
│ Local chat:   ${CONFIG.local.chatModel.padEnd(38)}│
│ Local auto:   ${CONFIG.local.autocompleteModel.padEnd(38)}│
│ Cloud route:  ${CONFIG.openrouter.model.padEnd(38)}│
│ Local ctx:    ${String(CONFIG.local.contextWindowTokens).padEnd(38)}│
│ Prompt budget:${String(getLocalPromptBudgetTokens()).padEnd(38)}│
│ OpenRouter:   ${(CONFIG.openrouter.apiKey ? "configured" : "missing").padEnd(38)}│
└────────────────────────────────────────────────────────┘
`);
});
