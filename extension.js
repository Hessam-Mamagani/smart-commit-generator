const vscode = require("vscode");
const { execFile } = require("child_process");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_DIFF_EXCLUDES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "go.sum",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.snap",
  "dist/**",
  "build/**",
  ".next/**",
];

const SECRET_PROVIDERS = {
  gemini: {
    label: "Google Gemini",
    legacySetting: "geminiApiKey",
    secretKey: "smartCommit.apiKey.gemini",
    keyUrl: "https://aistudio.google.com/app/apikey",
    isFreeTier: true,
    optionalKey: false,
  },
  groq: {
    label: "Groq",
    legacySetting: "groqApiKey",
    secretKey: "smartCommit.apiKey.groq",
    keyUrl: "https://console.groq.com/keys",
    isFreeTier: true,
    optionalKey: false,
  },
  claude: {
    label: "Anthropic Claude",
    legacySetting: null,
    secretKey: "smartCommit.apiKey.claude",
    keyUrl: "https://console.anthropic.com/settings/keys",
    isFreeTier: false,
    optionalKey: false,
  },
  openai: {
    label: "OpenAI",
    legacySetting: "openaiApiKey",
    secretKey: "smartCommit.apiKey.openai",
    keyUrl: "https://platform.openai.com/api-keys",
    isFreeTier: false,
    optionalKey: false,
  },
  openrouter: {
    label: "OpenRouter",
    legacySetting: null,
    secretKey: "smartCommit.apiKey.openrouter",
    keyUrl: "https://openrouter.ai/keys",
    isFreeTier: false,
    optionalKey: false,
  },
  deepseek: {
    label: "DeepSeek",
    legacySetting: "deepseekApiKey",
    secretKey: "smartCommit.apiKey.deepseek",
    keyUrl: "https://platform.deepseek.com/api_keys",
    isFreeTier: false,
    optionalKey: false,
  },
  grok: {
    label: "Grok (xAI)",
    legacySetting: "grokApiKey",
    secretKey: "smartCommit.apiKey.grok",
    keyUrl: "https://console.x.ai",
    isFreeTier: false,
    optionalKey: false,
  },
  custom: {
    label: "Custom OpenAI-Compatible",
    legacySetting: null,
    secretKey: "smartCommit.apiKey.custom",
    keyUrl: "",
    isFreeTier: false,
    optionalKey: true,
  },
};

const SYSTEM_PROMPT = `You are an expert Git commit message generator following the Conventional Commits specification.
Generate a concise, accurate, and meaningful commit message based strictly on the provided git diff.

Rules:
1. First line format: <type>(<optional scope>): <imperative summary in lowercase, no trailing period>
   - Common types: feat, fix, refactor, perf, style, test, docs, chore
   - Keep the header under 72 characters.
2. If there are multiple notable changes, leave one blank line after the header and add short bullet points (- description).
3. Look closely at the actual code diff, including small edits, typos, or single-line fixes. Never invent or hallucinate features not present in the diff.
4. Output ONLY the raw commit message text. Do NOT wrap in markdown code blocks, do not include quotes, and do not add any introductory or explanatory text.`;

const PR_SYSTEM_PROMPT = `You are an expert technical lead and software engineer.
Analyze the provided commit history, file statistics, and diff to write a clear, professional Pull Request description in GitHub Markdown format.

Your output must follow this structure:
## Summary
A concise overview (2-3 sentences) of what this PR accomplishes and why.

## Key Changes
- Clear bulleted list of functional, architectural, or bugfix changes.
- Grouped logically if multiple areas are touched.

## Testing & Verification
- How the changes were tested and steps for reviewers to verify.
- Note any potential breaking changes or special setup instructions.

## Checklist
- [x] Code adheres to repository style standards
- [x] Tested locally and confirmed working

Output ONLY the markdown content. Do not wrap in outer code fences (\`\`\`).`;

const CONFLICT_SYSTEM_PROMPT = `You are an expert Git merge conflict resolution specialist and senior software engineer.
Analyze the provided merge conflict details, file statistics, and code chunks between the two branches.

Structure your response clearly with:
# Merge Conflict Analysis & Resolution Guide

## 1. Conflict Summary
- List of conflicting files
- Root cause (why both branches collided on these specific lines)

## 2. File-by-File Resolution
For each conflicting file:
### File: \`<filename>\`
- **Working Branch Intent**: What our current branch is accomplishing here.
- **Target Branch Intent**: What the incoming/target branch is accomplishing here.
- **Recommended Merged Code**:
\`\`\`<language>
// Provide the exact, production-ready merged code block that integrates both changes safely.
\`\`\`

## 3. Recommended Action Plan
- Step-by-step git commands to safely execute the merge and verify.

Output strictly formatted GitHub Markdown.`;

const BRANCH_COMPARE_SYSTEM_PROMPT = `You are a principal software architect.
Analyze the commits, modified files, and code diff between the working branch and the target branch.

Structure your response clearly with:
# Branch Comparison & Architecture Report

## 1. Executive Summary
High-level summary of the development scope, goals, and differences between these branches.

## 2. Key Changes & Architecture
- Detailed bullet points grouped by feature, module, or layer (e.g., UI/Frontend, API/Backend, Config).

## 3. Impact & Risk Assessment
- Breaking changes, database/schema changes, or environment variable requirements.
- Performance and security considerations.

## 4. Merge Readiness
- Status assessment (Ready to merge, needs tests, or review recommended).

Output strictly formatted GitHub Markdown.`;

let globalNotifyAllViews = null;
let extensionSecrets = null;
let isMigratingLegacyKeys = false;

function getSetting(key) {
  const config = vscode.workspace.getConfiguration("smartCommit");
  const val = config.get(key);
  if (val !== undefined && val !== null) return val;
  return "";
}

function buildCommitSystemPrompt() {
  let prompt = SYSTEM_PROMPT;
  const language = String(getSetting("commitLanguage") || "English").trim();
  const useGitmoji = Boolean(getSetting("useGitmoji"));
  const customPrompt = String(getSetting("customPrompt") || "").trim();

  if (language && language.toLowerCase() !== "english") {
    prompt += `\n5. Write the commit summary and bullet descriptions in ${language}. Keep the Conventional Commit type prefix (e.g., feat, fix, refactor, chore) in English.`;
  }
  if (useGitmoji) {
    prompt += `\n6. Prefix the commit header with the single most appropriate Gitmoji Unicode symbol for the commit type (e.g., sparkles for feat, bug for fix, wrench for chore, memo for docs, recycle for refactor, zap for perf).`;
  }
  if (customPrompt) {
    prompt += `\n\nAdditional user instructions:\n${customPrompt}`;
  }
  return prompt;
}

function buildPrSystemPrompt() {
  let prompt = PR_SYSTEM_PROMPT;
  const language = String(getSetting("commitLanguage") || "English").trim();
  if (language && language.toLowerCase() !== "english") {
    prompt += `\n\nWrite the PR summary, key changes, and verification sections in ${language}.`;
  }
  return prompt;
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(stderr?.trim() || err.message));
        }
        resolve(stdout);
      },
    );
  });
}

function getDiffExcludeArgs() {
  const configured = getSetting("excludeFromDiff");
  const patterns = Array.isArray(configured) ? configured : DEFAULT_DIFF_EXCLUDES;
  const specs = new Set();

  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    const p = raw.trim();
    if (!p) continue;
    specs.add(`:(glob,exclude)${p}`);
    if (!p.startsWith("**/")) {
      specs.add(`:(glob,exclude)**/${p}`);
    }
  }

  return specs.size > 0 ? ["--", ".", ...Array.from(specs)] : [];
}

async function runGitDiffFiltered(baseArgs, cwd) {
  const excludeArgs = getDiffExcludeArgs();
  if (excludeArgs.length === 0) {
    return await runGit(baseArgs, cwd);
  }
  try {
    return await runGit([...baseArgs, ...excludeArgs], cwd);
  } catch (e) {
    // Fallback for older Git binaries that may reject glob pathspec magic
    return await runGit(baseArgs, cwd);
  }
}

let currentTargetRepoUri = null;

function getTargetRepository(arg) {
  const gitExtension = vscode.extensions.getExtension("vscode.git");
  if (!gitExtension || !gitExtension.isActive) return null;
  const api = gitExtension.exports?.getAPI?.(1);
  if (!api || !api.repositories || api.repositories.length === 0) return null;

  // 1. Explicit argument from command or caller
  if (arg) {
    const uri = arg.rootUri || (arg.repository && arg.repository.rootUri);
    if (uri) {
      const match = api.repositories.find(
        (r) => r.rootUri.fsPath.toLowerCase() === uri.fsPath.toLowerCase(),
      );
      if (match) {
        currentTargetRepoUri = match.rootUri.fsPath;
        return match;
      }
    }
  }

  // 2. Currently active text document editor
  const activeDocUri = vscode.window.activeTextEditor?.document?.uri;
  if (activeDocUri) {
    const match = api.repositories.find((r) =>
      activeDocUri.fsPath
        .toLowerCase()
        .startsWith(r.rootUri.fsPath.toLowerCase()),
    );
    if (match) {
      currentTargetRepoUri = match.rootUri.fsPath;
      return match;
    }
  }

  // 3. User previously targeted repository in this session
  if (currentTargetRepoUri) {
    const match = api.repositories.find(
      (r) => r.rootUri.fsPath.toLowerCase() === currentTargetRepoUri.toLowerCase(),
    );
    if (match) return match;
  }

  // 4. In multi-root workspaces, automatically select repository that has uncommitted changes
  const repoWithChanges = api.repositories.find((r) => {
    const hasWorkingTree =
      r.state &&
      r.state.workingTreeChanges &&
      r.state.workingTreeChanges.length > 0;
    const hasIndex =
      r.state && r.state.indexChanges && r.state.indexChanges.length > 0;
    return hasWorkingTree || hasIndex;
  });
  if (repoWithChanges) {
    currentTargetRepoUri = repoWithChanges.rootUri.fsPath;
    return repoWithChanges;
  }

  return api.repositories[0];
}

function cleanCommitMessage(msg) {
  if (!msg) return "";
  let cleaned = msg.trim();
  if (cleaned.startsWith("```") && cleaned.endsWith("```")) {
    cleaned = cleaned
      .replace(/^```[a-z]*\r?\n?/, "")
      .replace(/\r?\n?```$/, "")
      .trim();
  }
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

function normalizeCustomChatUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.includes("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function requestOpenAICompatible({
  baseUrl,
  apiKey,
  model,
  userContent,
  systemPrompt = SYSTEM_PROMPT,
  maxTokens = 600,
  providerName = "AI",
  extraHeaders = {},
  timeoutMs = 45000,
}) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(baseUrl);
    } catch (e) {
      return reject(new Error(`${providerName}: Invalid endpoint URL "${baseUrl}".`));
    }
    const isHttps = urlObj.protocol === "https:";
    const httpLib = isHttps ? https : http;

    const payload = JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    });

    const headers = {
      "Content-Type": "application/json",
      ...extraHeaders,
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const options = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ""),
      method: "POST",
      headers,
    };

    const req = httpLib.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(
            new Error(
              `${providerName} API error (${res.statusCode}): ${body.slice(0, 300)}`,
            ),
          );
        }
        try {
          const json = JSON.parse(body);
          const content = json.choices?.[0]?.message?.content;
          const text = typeof content === "string" ? content.trim() : "";
          if (!text) {
            const reason = json.choices?.[0]?.finish_reason || "unknown";
            return reject(
              new Error(
                `${providerName} returned an empty response (finish_reason: ${reason}).`,
              ),
            );
          }
          resolve(cleanCommitMessage(text));
        } catch (e) {
          reject(new Error(`${providerName}: Failed to parse JSON response: ${e.message}`));
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(`${providerName} request timed out after ${Math.round(timeoutMs / 1000)}s.`),
      );
    });

    req.on("error", (err) => {
      if (
        providerName === "Ollama" &&
        (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND")
      ) {
        reject(
          new Error(
            "Cannot connect to local Ollama. Please ensure Ollama is running (`ollama run llama3.2`).",
          ),
        );
      } else {
        reject(err);
      }
    });
    req.write(payload);
    req.end();
  });
}

function requestClaude(
  apiKey,
  model,
  userContent,
  systemPrompt = SYSTEM_PROMPT,
  maxTokens = 800,
  timeoutMs = 45000,
) {
  return new Promise((resolve, reject) => {
    const modelName = model || "claude-haiku-5-5";
    const payload = JSON.stringify({
      model: modelName,
      max_tokens: Math.max(maxTokens, 800),
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    const req = https.request(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(`Claude API error (${res.statusCode}): ${body.slice(0, 300)}`),
            );
          }
          try {
            const json = JSON.parse(body);
            const blocks = Array.isArray(json.content) ? json.content : [];
            const text = blocks
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text)
              .join("")
              .trim();
            if (!text) {
              return reject(
                new Error(
                  `Claude returned an empty response (stop_reason: ${json.stop_reason || "unknown"}).`,
                ),
              );
            }
            resolve(cleanCommitMessage(text));
          } catch (e) {
            reject(new Error(`Claude: Failed to parse JSON response: ${e.message}`));
          }
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Claude request timed out after ${Math.round(timeoutMs / 1000)}s.`));
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function hasBuiltInVsCodeLm() {
  try {
    if (!vscode.lm || typeof vscode.lm.selectChatModels !== "function") {
      return false;
    }
    const models = await vscode.lm.selectChatModels({});
    return Array.isArray(models) && models.length > 0;
  } catch (e) {
    return false;
  }
}

async function requestVsCodeLm(modelOverride, userContent, systemPrompt = SYSTEM_PROMPT) {
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== "function") {
    throw new Error(
      "Built-in IDE AI requires VS Code 1.90+ with an active language model extension (e.g., GitHub Copilot).",
    );
  }

  const models = await vscode.lm.selectChatModels({});
  if (!models || models.length === 0) {
    throw new Error(
      "No built-in IDE AI model found. Sign in to GitHub Copilot or switch provider (e.g., Gemini, Groq, or Ollama).",
    );
  }

  let selected = null;
  if (modelOverride) {
    const target = modelOverride.toLowerCase();
    selected = models.find((m) =>
      `${m.id} ${m.family} ${m.name}`.toLowerCase().includes(target),
    );
  }
  if (!selected) {
    selected =
      models.find((m) =>
        /mini|flash|haiku|small|4o-mini/i.test(`${m.id} ${m.family} ${m.name}`),
      ) || models[0];
  }

  const messages = [
    vscode.LanguageModelChatMessage.User(`${systemPrompt}\n\n${userContent}`),
  ];
  const cts = new vscode.CancellationTokenSource();
  try {
    const response = await selected.sendRequest(messages, {}, cts.token);
    let result = "";
    for await (const chunk of response.text) {
      result += chunk;
    }
    const cleaned = cleanCommitMessage(result);
    if (!cleaned) {
      throw new Error("Built-in IDE AI returned an empty response.");
    }
    return cleaned;
  } finally {
    cts.dispose();
  }
}

function requestOpenAI(
  apiKey,
  model,
  userContent,
  systemPrompt = SYSTEM_PROMPT,
  maxTokens = 600,
) {
  return requestOpenAICompatible({
    baseUrl: "https://api.openai.com/v1/chat/completions",
    apiKey,
    model: model || "gpt-4o-mini",
    userContent,
    systemPrompt,
    maxTokens,
    providerName: "OpenAI",
  });
}

function sendGeminiRequest(
  apiKey,
  modelName,
  userContent,
  systemPrompt,
  generationConfig,
  timeoutMs = 45000,
) {
  return new Promise((resolve, reject) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const payload = JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig,
    });

    const req = https.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            const err = new Error(
              `Gemini API error (${res.statusCode}): ${body.slice(0, 300)}`,
            );
            err.statusCode = res.statusCode;
            return reject(err);
          }
          try {
            const json = JSON.parse(body);
            const candidate = json.candidates?.[0];
            const parts = candidate?.content?.parts || [];
            // Exclude reasoning/thought blocks so only the final response is returned
            const text = parts
              .filter((p) => !p.thought && typeof p.text === "string")
              .map((p) => p.text)
              .join("")
              .trim();
            if (!text) {
              const reason = candidate?.finishReason || "unknown";
              return reject(
                new Error(
                  `Gemini returned an empty response (finishReason: ${reason}).`,
                ),
              );
            }
            resolve(cleanCommitMessage(text));
          } catch (e) {
            reject(new Error(`Gemini: Failed to parse JSON response: ${e.message}`));
          }
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s.`));
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function requestGemini(
  apiKey,
  model,
  userContent,
  systemPrompt = SYSTEM_PROMPT,
  maxTokens = 600,
) {
  const modelName = model || "gemini-3.8-flash";
  // Give generous output headroom so reasoning/thinking tokens never starve the visible answer
  const effectiveMaxTokens = Math.max(maxTokens * 3, 2048);
  const generationConfig = {
    temperature: 0.2,
    maxOutputTokens: effectiveMaxTokens,
  };

  const usesGemini3Thinking = /^gemini-[3-9]/i.test(modelName);
  if (usesGemini3Thinking) {
    generationConfig.thinkingConfig = {
      thinkingLevel: maxTokens <= 800 ? "minimal" : "low",
    };
  }

  try {
    return await sendGeminiRequest(
      apiKey,
      modelName,
      userContent,
      systemPrompt,
      generationConfig,
    );
  } catch (err) {
    // If a custom/older Gemini model rejects thinkingConfig, retry cleanly without it
    if (usesGemini3Thinking && err.statusCode === 400) {
      const fallbackConfig = {
        temperature: 0.2,
        maxOutputTokens: effectiveMaxTokens,
      };
      return await sendGeminiRequest(
        apiKey,
        modelName,
        userContent,
        systemPrompt,
        fallbackConfig,
      );
    }
    throw err;
  }
}

async function executeAiCompletion(
  provider,
  apiKey,
  modelOverride,
  userContent,
  systemPrompt = SYSTEM_PROMPT,
  maxTokens = 600,
) {
  if (provider === "vscode-lm") {
    return await requestVsCodeLm(modelOverride, userContent, systemPrompt);
  }
  if (provider === "gemini") {
    return await requestGemini(
      apiKey,
      modelOverride,
      userContent,
      systemPrompt,
      maxTokens,
    );
  }
  if (provider === "claude") {
    return await requestClaude(
      apiKey,
      modelOverride,
      userContent,
      systemPrompt,
      maxTokens,
    );
  }
  if (provider === "deepseek") {
    return await requestOpenAICompatible({
      baseUrl: "https://api.deepseek.com/chat/completions",
      apiKey,
      model: modelOverride || "deepseek-chat",
      userContent,
      systemPrompt,
      maxTokens,
      providerName: "DeepSeek",
    });
  }
  if (provider === "groq") {
    return await requestOpenAICompatible({
      baseUrl: "https://api.groq.com/openai/v1/chat/completions",
      apiKey,
      model: modelOverride || "llama-3.3-70b-versatile",
      userContent,
      systemPrompt,
      maxTokens,
      providerName: "Groq",
    });
  }
  if (provider === "grok") {
    return await requestOpenAICompatible({
      baseUrl: "https://api.x.ai/v1/chat/completions",
      apiKey,
      model: modelOverride || "grok-4.20-0309-non-reasoning",
      userContent,
      systemPrompt,
      maxTokens,
      providerName: "Grok",
    });
  }
  if (provider === "openrouter") {
    return await requestOpenAICompatible({
      baseUrl: "https://openrouter.ai/api/v1/chat/completions",
      apiKey,
      model: modelOverride || "openai/gpt-4o-mini",
      userContent,
      systemPrompt,
      maxTokens,
      providerName: "OpenRouter",
      extraHeaders: {
        "HTTP-Referer": "https://github.com/Hessam-Mamagani/smart-commit-generator",
        "X-Title": "Smart Commit Generator AI",
      },
    });
  }
  if (provider === "ollama") {
    const endpoint = getSetting("ollamaEndpoint") || "http://localhost:11434";
    const baseUrl = endpoint.replace(/\/+$/, "") + "/v1/chat/completions";
    return await requestOpenAICompatible({
      baseUrl,
      apiKey: "",
      model: modelOverride || "llama3.2",
      userContent,
      systemPrompt,
      maxTokens,
      providerName: "Ollama",
    });
  }
  if (provider === "custom") {
    const rawEndpoint = getSetting("customBaseUrl");
    const baseUrl = normalizeCustomChatUrl(rawEndpoint);
    if (!baseUrl) {
      throw new Error(
        "Custom provider requires `smartCommit.customBaseUrl` to be configured.",
      );
    }
    return await requestOpenAICompatible({
      baseUrl,
      apiKey: apiKey === "custom-no-key" ? "" : apiKey,
      model: modelOverride || "gpt-4o-mini",
      userContent,
      systemPrompt,
      maxTokens,
      providerName: "Custom AI",
    });
  }
  return await requestOpenAI(
    apiKey,
    modelOverride,
    userContent,
    systemPrompt,
    maxTokens,
  );
}

async function migrateLegacyApiKey(provider) {
  const meta = SECRET_PROVIDERS[provider];
  if (!meta || !meta.legacySetting || !extensionSecrets) return null;

  const config = vscode.workspace.getConfiguration("smartCommit");
  const inspected = config.inspect(meta.legacySetting);
  const legacyKey = (
    inspected?.workspaceFolderValue ||
    inspected?.workspaceValue ||
    inspected?.globalValue ||
    ""
  ).trim();

  if (!legacyKey) return null;

  await extensionSecrets.store(meta.secretKey, legacyKey);

  // Clear plaintext key from settings.json after storing it safely in SecretStorage
  try {
    if (inspected?.globalValue) {
      await config.update(meta.legacySetting, undefined, vscode.ConfigurationTarget.Global);
    }
    if (inspected?.workspaceValue) {
      await config.update(meta.legacySetting, undefined, vscode.ConfigurationTarget.Workspace);
    }
  } catch (e) {}

  return legacyKey;
}

async function migrateAllLegacyApiKeys(silent = true) {
  if (!extensionSecrets || isMigratingLegacyKeys) return;
  isMigratingLegacyKeys = true;
  const migrated = [];
  try {
    for (const [provider, meta] of Object.entries(SECRET_PROVIDERS)) {
      if (!meta.legacySetting) continue;
      const key = await migrateLegacyApiKey(provider);
      if (key) migrated.push(meta.label);
    }
    if (!silent && migrated.length > 0) {
      vscode.window.showInformationMessage(
        `Smart Git: Migrated ${migrated.join(", ")} API key(s) from plaintext settings.json into VS Code encrypted Secret Storage.`,
      );
    }
  } finally {
    isMigratingLegacyKeys = false;
  }
}

async function getStoredApiKey(provider) {
  const meta = SECRET_PROVIDERS[provider];
  if (!meta) return "";
  if (extensionSecrets) {
    const stored = (await extensionSecrets.get(meta.secretKey)) || "";
    if (stored.trim()) return stored.trim();
    const migrated = await migrateLegacyApiKey(provider);
    if (migrated) return migrated;
  }
  if (meta.legacySetting) {
    return String(getSetting(meta.legacySetting) || "").trim();
  }
  return "";
}

async function storeApiKey(provider, apiKey) {
  const meta = SECRET_PROVIDERS[provider];
  if (!meta || !extensionSecrets) return;
  const cleaned = String(apiKey || "").trim();
  if (cleaned) {
    await extensionSecrets.store(meta.secretKey, cleaned);
  } else {
    await extensionSecrets.delete(meta.secretKey);
  }
}

async function resolveProviderContext() {
  let provider = getSetting("provider") || "gemini";
  const modelOverride = String(getSetting("model") || "").trim();

  if (provider === "ollama") {
    return { provider, apiKey: "local-ollama", modelOverride };
  }

  if (provider === "vscode-lm") {
    return { provider, apiKey: "vscode-lm", modelOverride };
  }

  if (provider === "custom") {
    let customUrl = String(getSetting("customBaseUrl") || "").trim();
    if (!customUrl) {
      const enteredUrl = await vscode.window.showInputBox({
        title: "Smart Git: Custom OpenAI-Compatible Endpoint",
        prompt: "Enter your endpoint base URL (e.g. http://localhost:1234/v1)",
        ignoreFocusOut: true,
      });
      if (!enteredUrl || !enteredUrl.trim()) return null;
      customUrl = enteredUrl.trim();
      await vscode.workspace
        .getConfiguration("smartCommit")
        .update("customBaseUrl", customUrl, vscode.ConfigurationTarget.Global);
    }
    const storedCustomKey = await getStoredApiKey("custom");
    return {
      provider,
      apiKey: storedCustomKey || "custom-no-key",
      modelOverride,
    };
  }

  const meta = SECRET_PROVIDERS[provider] || SECRET_PROVIDERS.openai;
  let apiKey = await getStoredApiKey(provider);

  if (!apiKey) {
    const canUseBuiltInLm = await hasBuiltInVsCodeLm();
    const getKeyAction = meta.isFreeTier ? "Get Free API Key" : "Get API Key";
    const buttons = [];
    if (canUseBuiltInLm) {
      buttons.push("Use Built-in IDE AI (No Key)");
    }
    buttons.push("Enter API Key");
    if (meta.keyUrl) {
      buttons.push(getKeyAction);
    }
    buttons.push("Switch Provider");

    const choice = await vscode.window.showWarningMessage(
      `Smart Git: No API key configured for "${meta.label}". Keys are stored securely in VS Code encrypted Secret Storage.`,
      ...buttons,
    );

    if (choice === "Use Built-in IDE AI (No Key)") {
      await vscode.workspace
        .getConfiguration("smartCommit")
        .update("provider", "vscode-lm", vscode.ConfigurationTarget.Global);
      if (globalNotifyAllViews) globalNotifyAllViews();
      return { provider: "vscode-lm", apiKey: "vscode-lm", modelOverride };
    }

    if (choice === getKeyAction && meta.keyUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(meta.keyUrl));
      const entered = await vscode.window.showInputBox({
        title: `Smart Git: Save ${meta.label} API Key (Encrypted)`,
        prompt: `Paste your ${meta.label} API Key (saved securely in VS Code Secret Storage)`,
        password: true,
        ignoreFocusOut: true,
      });
      if (entered && entered.trim()) {
        apiKey = entered.trim();
        await storeApiKey(provider, apiKey);
        vscode.window.showInformationMessage(
          `Smart Git: ${meta.label} API Key saved securely!`,
        );
        return { provider, apiKey, modelOverride };
      }
      return null;
    }

    if (choice === "Enter API Key") {
      const entered = await vscode.window.showInputBox({
        title: `Smart Git: Save ${meta.label} API Key (Encrypted)`,
        prompt: `Paste your ${meta.label} API Key (saved securely in VS Code Secret Storage)`,
        password: true,
        ignoreFocusOut: true,
      });
      if (entered && entered.trim()) {
        apiKey = entered.trim();
        await storeApiKey(provider, apiKey);
        vscode.window.showInformationMessage(
          `Smart Git: ${meta.label} API Key saved securely!`,
        );
        return { provider, apiKey, modelOverride };
      }
      return null;
    }

    if (choice === "Switch Provider") {
      await vscode.commands.executeCommand("smartCommit.selectProvider");
      return null;
    }

    return null;
  }

  return { provider, apiKey, modelOverride };
}

async function buildDiffContent(cwd, autoStage = false) {
  let stagedStat = await runGit(["diff", "--cached", "--stat"], cwd);

  if (!stagedStat.trim() && autoStage) {
    await runGit(["add", "-A"], cwd);
    stagedStat = await runGit(["diff", "--cached", "--stat"], cwd);
  }

  if (stagedStat.trim()) {
    const stagedDiff = await runGitDiffFiltered(["diff", "--cached"], cwd);
    if (stagedDiff.trim()) {
      return `STAGED CHANGES SUMMARY:\n${stagedStat}\n\nSTAGED DIFF:\n${stagedDiff}`;
    }
    return `STAGED CHANGES SUMMARY (only lockfiles or excluded generated files modified):\n${stagedStat}`;
  }

  const unstagedStat = await runGit(["diff", "--stat"], cwd);
  if (unstagedStat.trim()) {
    const unstagedDiff = await runGitDiffFiltered(["diff"], cwd);
    if (unstagedDiff.trim()) {
      return `UNSTAGED CHANGES SUMMARY:\n${unstagedStat}\n\nUNSTAGED DIFF:\n${unstagedDiff}`;
    }
    return `UNSTAGED CHANGES SUMMARY (only lockfiles or excluded generated files modified):\n${unstagedStat}`;
  }

  const status = await runGit(["status", "--short"], cwd);
  if (!status.trim()) {
    return null;
  }
  return `UNTRACKED / MODIFIED FILES STATUS:\n${status}`;
}

function inspectDiffPreFlight(diffText, branchName = "") {
  const warnings = [];
  const lines = (diffText || "").split("\n");

  let currentFile = "unknown";
  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.replace("+++ b/", "").trim();
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const addedCode = line.substring(1);

      // Skip comments
      if (/^\s*(?:\/\/|\/\*|\*|#|<!--|%|--)/.test(addedCode)) continue;

      // Skip self-referential pre-flight checker definitions or test files
      if (
        addedCode.includes("inspectDiffPreFlight") ||
        addedCode.includes("DEBUG_DETECTORS") ||
        addedCode.includes("isDebugCall") ||
        currentFile.includes("test")
      ) {
        continue;
      }

      // Strip string literals and regex literals so pattern definitions or quotes don't trigger false positives
      const sanitizedCode = addedCode
        .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')
        .replace(/\/(?:\\.|[^\/\\\r\n])+\/[gimsuy]*/g, '""');

      const isDebugCall =
        /\bconsole\.(?:log|debug|warn|error)\s*\(|\bdebugger\s*(?:;|$)|(?<![\w$])print\s*\(|(?<![\w$])dd\s*\(|(?<![\w$])var_dump\s*\(/i.test(
          sanitizedCode,
        );

      if (isDebugCall) {
        warnings.push({
          type: "debug_artifact",
          file: currentFile,
          line: addedCode.trim().slice(0, 80),
        });
      }
    }
  }

  let ticketId = null;
  if (branchName) {
    const match = branchName.match(
      /([A-Z]{2,10}-\d+|#\d+|\b(?:issue|bug|feat)-(\d+))/i,
    );
    if (match) {
      ticketId = match[1].toUpperCase();
    }
  }

  return {
    warnings,
    hasDebugArtifacts: warnings.length > 0,
    ticketId,
  };
}

async function generateCommitMessage(repo, autoStage = false) {
  const cwd = repo.rootUri.fsPath;
  const ctx = await resolveProviderContext();
  if (!ctx) return null;

  let diffContent = await buildDiffContent(cwd, autoStage);
  if (!diffContent) {
    vscode.window.showInformationMessage(
      "Smart Commit: No changes detected to commit.",
    );
    return null;
  }

  let currentBranch = "";
  try {
    currentBranch = (
      await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
    ).trim();
  } catch (e) {}

  const preFlight = inspectDiffPreFlight(diffContent, currentBranch);

  if (diffContent.length > 30000) {
    diffContent =
      diffContent.slice(0, 30000) + "\n\n[Diff truncated for length...]";
  }

  let ticketInstruction = "";
  if (preFlight.ticketId) {
    ticketInstruction = `Branch issue ticket detected: "${preFlight.ticketId}". Include this ticket ID in the commit scope or header (e.g. "<type>(${preFlight.ticketId}): <summary>").\n\n`;
  }

  const userPrompt = `Analyze this git diff and produce the commit message:\n${ticketInstruction}${diffContent}`;
  const commitMsg = await executeAiCompletion(
    ctx.provider,
    ctx.apiKey,
    ctx.modelOverride,
    userPrompt,
    buildCommitSystemPrompt(),
    600,
  );

  if (preFlight.hasDebugArtifacts) {
    vscode.window.showWarningMessage(
      `Smart Git: Pre-flight check detected ${preFlight.warnings.length} debug artifact(s) (e.g. ${preFlight.warnings[0].line} in ${preFlight.warnings[0].file}).`,
    );
  }

  return commitMsg;
}

async function getBranches(cwd, currentBranch) {
  try {
    const output = await runGit(["branch", "-a"], cwd);
    const lines = output.split("\n");
    const branches = new Set();

    for (const line of lines) {
      let b = line.trim();
      if (!b || b.startsWith("*")) continue;
      if (b.includes("->")) continue;
      if (b.startsWith("remotes/")) {
        b = b.replace(/^remotes\//, "");
      }
      if (b && b !== currentBranch && b !== `origin/${currentBranch}`) {
        branches.add(b);
      }
    }

    return Array.from(branches).sort((a, b) => {
      const aRemote = a.startsWith("origin/");
      const bRemote = b.startsWith("origin/");
      if (!aRemote && bRemote) return -1;
      if (aRemote && !bRemote) return 1;
      return a.localeCompare(b);
    });
  } catch (e) {
    return [];
  }
}

async function checkMergeConflicts(cwd, currentBranch, targetBranch) {
  let mergeBase = "";
  try {
    mergeBase = (
      await runGit(["merge-base", "HEAD", targetBranch], cwd)
    ).trim();
  } catch (e) {
    return {
      hasConflicts: false,
      mergeBase: "",
      output: "No common ancestor.",
    };
  }

  let mergeTreeOutput = "";
  try {
    mergeTreeOutput = await runGit(
      ["merge-tree", mergeBase, "HEAD", targetBranch],
      cwd,
    );
  } catch (e) {
    mergeTreeOutput = e.message || "";
  }

  const hasConflictMarkers =
    mergeTreeOutput.includes("<<<<<<<") ||
    mergeTreeOutput.includes("changed in both") ||
    mergeTreeOutput.includes("conflict");

  return {
    hasConflicts: hasConflictMarkers,
    mergeBase,
    output: mergeTreeOutput,
  };
}

function scanDiffForSecurityIssues(diffText) {
  if (!diffText) return [];
  const issues = [];
  const lines = diffText.split("\n");

  const secretPatterns = [
    { name: "OpenAI Secret Key", regex: /sk-[a-zA-Z0-9]{20,}/ },
    { name: "Google / Gemini API Key", regex: /AIza[0-9A-Za-z\-_]{35}/ },
    { name: "AWS Access Key ID", regex: /AKIA[0-9A-Z]{16}/ },
    {
      name: "GitHub Personal Access Token",
      regex: /(?:ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,})/,
    },
    {
      name: "Private Encryption Key",
      regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    },
    {
      name: "Hardcoded Secret / Token Assignment",
      regex:
        /(?:api[_-]?key|secret|password|auth[_-]?token)\s*[:=]\s*['"][a-zA-Z0-9_\-\.]{8,}['"]/i,
    },
  ];

  let currentFile = "";
  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.replace("+++ b/", "").trim();
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const addedContent = line.slice(1);
      if (
        addedContent.includes("your-api-key") ||
        addedContent.includes("sk-placeholder") ||
        addedContent.includes("EXAMPLE")
      ) {
        continue;
      }
      for (const pattern of secretPatterns) {
        if (pattern.regex.test(addedContent)) {
          issues.push({
            type: pattern.name,
            file: currentFile || "unknown file",
          });
          break;
        }
      }
    }
  }

  return issues;
}

function getPackageJsonInfo(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    return { pkgPath, version: pkg.version || "1.0.0", pkg };
  } catch (e) {
    return null;
  }
}

function calculateNextVersions(currentVersion, commitLog = "") {
  const parts = currentVersion.split(".").map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);

  const [major, minor, patch] = parts;

  let recommendedType = "patch";
  if (commitLog.includes("BREAKING CHANGE") || /^[a-z]+!:/m.test(commitLog)) {
    recommendedType = "major";
  } else if (/^feat(?:\([^\)]+\))?:/m.test(commitLog)) {
    recommendedType = "minor";
  }

  const patchVersion = `${major}.${minor}.${patch + 1}`;
  const minorVersion = `${major}.${minor + 1}.0`;
  const majorVersion = `${major + 1}.0.0`;

  let recommendedVersion = patchVersion;
  if (recommendedType === "major") recommendedVersion = majorVersion;
  else if (recommendedType === "minor") recommendedVersion = minorVersion;

  return {
    currentVersion,
    recommendedType,
    recommendedVersion,
    patchVersion,
    minorVersion,
    majorVersion,
  };
}

async function applyVersionBump(pkgInfo, newVersion, cwd) {
  try {
    pkgInfo.pkg.version = newVersion;
    const jsonStr = JSON.stringify(pkgInfo.pkg, null, 2) + "\n";
    fs.writeFileSync(pkgInfo.pkgPath, jsonStr, "utf8");
    // Automatically update CHANGELOG.md with recent commits
    try {
      const changelogPath = path.join(cwd, "CHANGELOG.md");
      if (fs.existsSync(changelogPath)) {
        let changelog = fs.readFileSync(changelogPath, "utf8");
        const today = new Date().toISOString().split("T")[0];

        let commitLines = [];
        try {
          const logRaw = await runGit(
            ["log", "-n", "8", "--pretty=format:%s"],
            cwd,
          );
          commitLines = logRaw
            .split("\n")
            .map((s) => s.trim())
            .filter(
              (s) =>
                s &&
                !s.startsWith("chore(release):") &&
                !s.startsWith("Merge "),
            );
        } catch (e) {}

        const bulletPoints =
          commitLines.length > 0
            ? commitLines.map((s) => `- ${s}`).join("\n")
            : "- Performance enhancements and minor bug fixes.";

        const newEntry = `## [${newVersion}] - ${today}\n\n### Added & Improved\n${bulletPoints}\n\n---\n\n`;

        const firstVersionIndex = changelog.search(/##\s+\[/);
        if (firstVersionIndex !== -1) {
          changelog =
            changelog.slice(0, firstVersionIndex) +
            newEntry +
            changelog.slice(firstVersionIndex);
          fs.writeFileSync(changelogPath, changelog, "utf8");
          await runGit(["add", "CHANGELOG.md"], cwd);
        }
      }
    } catch (e) {}

    await runGit(["add", "package.json"], cwd);
    await runGit(
      ["commit", "-m", `chore(release): bump version to ${newVersion}`],
      cwd,
    );
    return true;
  } catch (e) {
    return false;
  }
}

async function promptVersionSelection(versionPlan) {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: `$(tag) Patch: v${versionPlan.patchVersion}`,
        description:
          versionPlan.recommendedType === "patch"
            ? "(Recommended) Bug fixes & minor updates"
            : "Bug fixes & minor updates",
        version: versionPlan.patchVersion,
      },
      {
        label: `$(tag) Minor: v${versionPlan.minorVersion}`,
        description:
          versionPlan.recommendedType === "minor"
            ? "(Recommended) New features & functionality"
            : "New features & functionality",
        version: versionPlan.minorVersion,
      },
      {
        label: `$(tag) Major: v${versionPlan.majorVersion}`,
        description:
          versionPlan.recommendedType === "major"
            ? "(Recommended) Breaking changes"
            : "Breaking changes",
        version: versionPlan.majorVersion,
      },
      {
        label: `$(history) Keep Current: v${versionPlan.currentVersion}`,
        description: "Push without modifying version",
        version: null,
      },
    ],
    {
      title: "Smart Git: Select Release Version",
      placeHolder: `Current version is v${versionPlan.currentVersion}. Choose version for this release:`,
    },
  );

  return choice ? choice.version : undefined;
}

async function executeBranchSyncAndPush(
  cwd,
  currentBranch,
  targetBranch,
  targetVersion = null,
) {
  try {
    const status = (await runGit(["status", "--short"], cwd)).trim();
    if (status) {
      vscode.window.showWarningMessage(
        "Smart Git: Please commit or stash your working tree changes before syncing branches.",
      );
      return false;
    }
  } catch (e) {
    return false;
  }

  let success = false;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: targetVersion
        ? `Smart Git: Releasing v${targetVersion} to "${targetBranch}" & pushing...`
        : `Smart Git: Merging "${currentBranch}" into "${targetBranch}" & pushing...`,
      cancellable: false,
    },
    async () => {
      try {
        await runGit(["checkout", targetBranch], cwd);
        await runGit(["merge", currentBranch], cwd);
        await runGit(["push", "origin", targetBranch], cwd);
        await runGit(["checkout", currentBranch], cwd);
        // Also push currentBranch so any version bump commit is on remote
        await runGit(["push", "origin", currentBranch], cwd).catch(() => {});
        vscode.window.showInformationMessage(
          targetVersion
            ? `Smart Git: Successfully released v${targetVersion} to "${targetBranch}" and pushed to remote!`
            : `Smart Git: Successfully synced "${currentBranch}" into "${targetBranch}" and pushed to remote!`,
        );
        success = true;
      } catch (err) {
        await runGit(["checkout", currentBranch], cwd).catch(() => {});
        vscode.window.showErrorMessage(`Smart Git Sync Error: ${err.message}`);
      }
    },
  );
  return success;
}

function updateStatusBarItem(statusBar) {
  const confirmPush = getSetting("confirmBeforePush");
  const isFast = confirmPush === false;
  statusBar.text = isFast
    ? "$(zap) Smart Git (Fast)"
    : "$(shield) Smart Git (Safe)";
  statusBar.tooltip = isFast
    ? "Smart Git: Fast Mode active (Instant 1-click push without dialog). Click for actions."
    : "Smart Git: Safe Mode active (Confirms before pushing). Click for actions.";
}

function activate(context) {
  extensionSecrets = context.secrets;
  migrateAllLegacyApiKeys(false).catch(() => {});

  // 1. Status Bar Quick Launcher
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBar.command = "smartCommit.quickMenu";
  updateStatusBarItem(statusBar);
  statusBar.show();

  // 2. Initial Fast Mode context for dynamic toolbar button icons
  const initialFast = getSetting("confirmBeforePush") === false;
  vscode.commands.executeCommand(
    "setContext",
    "smartCommit:isFastMode",
    initialFast,
  );

  // Auto-sync context, status bar, secure key migration, and views when configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("smartCommit")) {
        const isFast = getSetting("confirmBeforePush") === false;
        vscode.commands.executeCommand(
          "setContext",
          "smartCommit:isFastMode",
          isFast,
        );
        updateStatusBarItem(statusBar);
        migrateAllLegacyApiKeys(false).catch(() => {});
        if (globalNotifyAllViews) {
          globalNotifyAllViews();
        }
      }
    }),
  );

  // Fast Mode toggle helper
  async function setFastPushMode(enableFast) {
    await vscode.workspace
      .getConfiguration("smartCommit")
      .update(
        "confirmBeforePush",
        !enableFast,
        vscode.ConfigurationTarget.Global,
      );
    await vscode.commands.executeCommand(
      "setContext",
      "smartCommit:isFastMode",
      enableFast,
    );
    updateStatusBarItem(statusBar);
    if (globalNotifyAllViews) {
      globalNotifyAllViews();
    }
    vscode.window.showInformationMessage(
      enableFast
        ? "Smart Git: Fast Mode enabled (Instant 1-click push with zero dialogs)."
        : "Smart Git: Safe Mode enabled (Shows confirmation modal before pushing).",
    );
  }

  // 3. Interactive Quick Menu
  const disposableQuickMenu = vscode.commands.registerCommand(
    "smartCommit.quickMenu",
    async () => {
      const isFast = getSetting("confirmBeforePush") === false;

      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "$(sparkle) Generate Commit Message",
            description: "Inspect staged diff and insert into commit box",
            command: "smartCommit.generate",
          },
          {
            label: "$(cloud-upload) Generate, Commit & Push",
            description: isFast
              ? "Instant 1-click push (Fast Mode)"
              : "Stage, commit, and push with confirmation",
            command: "smartCommit.generateCommitAndPush",
          },
          {
            label: "$(cloud-upload) Push Commits to Remote",
            description: "Push pending local commits to origin",
            command: "smartCommit.pushCommits",
          },
          {
            label: "$(discard) Undo Last Commit (Soft Reset)",
            description: "Uncommit to staged area & restore message to edit or regenerate with AI",
            command: "smartCommit.undoCommit",
          },
          {
            label: "$(git-merge) Safe Sync & Push to Branch",
            description:
              "Auto-checks for conflicts before merging & pushing to target branch",
            command: "smartCommit.syncToBranch",
          },
          {
            label: "$(git-pull-request) Generate PR Description",
            description:
              "Create GitHub Markdown PR summary against base branch",
            command: "smartCommit.generatePR",
          },
          {
            label: "$(diff) Compare Branches & Conflict Advisor",
            description:
              "Dry-run merge analysis and AI conflict resolution guide",
            command: "smartCommit.compareBranches",
          },
          {
            label: isFast
              ? "$(shield) Switch to Safe Mode"
              : "$(zap) Switch to Fast Mode (Instant Push)",
            description: isFast
              ? "Show confirmation dialog before push"
              : "Skip confirmation dialog for instant push",
            command: "smartCommit.toggleFastPush",
          },
          {
            label: "$(key) Manage API Keys (Secure Storage)",
            description: "Add, update, or remove encrypted AI provider keys",
            command: "smartCommit.manageApiKeys",
          },
          {
            label: "$(gear) Extension Settings",
            description: "Configure AI provider, commit language, exclusions & prompts",
            command: "workbench.action.openSettings",
            args: ["smartCommit"],
          },
        ],
        {
          placeHolder: "Smart Git Assistant - Select an Action",
        },
      );

      if (choice) {
        if (choice.args) {
          vscode.commands.executeCommand(choice.command, ...choice.args);
        } else {
          vscode.commands.executeCommand(choice.command);
        }
      }
    },
  );

  // 4. Fast Mode Toggle Commands
  const disposableToggleFast = vscode.commands.registerCommand(
    "smartCommit.toggleFastPush",
    async () => {
      const isFast = getSetting("confirmBeforePush") === false;
      await setFastPushMode(!isFast);
    },
  );

  const disposableEnableFast = vscode.commands.registerCommand(
    "smartCommit.enableFastMode",
    async () => {
      await setFastPushMode(true);
    },
  );

  const disposableDisableFast = vscode.commands.registerCommand(
    "smartCommit.disableFastMode",
    async () => {
      await setFastPushMode(false);
    },
  );

  // 4. Command: Generate Message
  const disposableGenerate = vscode.commands.registerCommand(
    "smartCommit.generate",
    async (arg) => {
      const repo = getTargetRepository(arg);
      if (!repo) {
        vscode.window.showErrorMessage("No active Git repository found.");
        return;
      }

      const autoStage = Boolean(getSetting("autoStage"));
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Smart Commit: Generating commit message...",
          cancellable: false,
        },
        async () => {
          try {
            const msg = await generateCommitMessage(repo, autoStage);
            if (msg) {
              repo.inputBox.value = msg;
              notifyAllViews({ commitText: msg });
              vscode.window.setStatusBarMessage(
                "Smart Commit: Message updated!",
                3000,
              );
            }
          } catch (err) {
            vscode.window.showErrorMessage(
              `Smart Commit Error: ${err.message}`,
            );
          }
        },
      );
    },
  );

  // 5. Command: Generate, Commit & Push
  const disposableCommitAndPush = vscode.commands.registerCommand(
    "smartCommit.generateCommitAndPush",
    async (arg) => {
      const repo = getTargetRepository(arg);
      if (!repo) {
        vscode.window.showErrorMessage("No active Git repository found.");
        return;
      }

      const cwd = repo.rootUri.fsPath;
      let msg = "";

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Smart Commit: Generating commit message...",
          cancellable: false,
        },
        async () => {
          try {
            const stagedCheck = await runGit(["diff", "--cached"], cwd);
            if (!stagedCheck.trim()) {
              await runGit(["add", "-A"], cwd);
            }
            msg = await generateCommitMessage(repo, false);
            if (msg) {
              repo.inputBox.value = msg;
            }
          } catch (err) {
            vscode.window.showErrorMessage(
              `Smart Commit Error: ${err.message}`,
            );
          }
        },
      );

      if (!msg) return;

      const confirmPush = getSetting("confirmBeforePush");
      let proceedAction = "Commit & Push";

      if (confirmPush !== false) {
        const firstLine = msg.split("\n")[0];
        const choice = await vscode.window.showInformationMessage(
          "Smart Commit: Commit & Push to Remote?",
          {
            modal: true,
            detail: `Generated Message:\n"${firstLine}"\n\nWould you like to commit and push these changes to remote now?`,
          },
          "Commit & Push",
          "Only Commit",
        );

        if (!choice) return;
        proceedAction = choice;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title:
            proceedAction === "Commit & Push"
              ? "Smart Commit: Committing and pushing to remote..."
              : "Smart Commit: Committing changes...",
          cancellable: false,
        },
        async () => {
          try {
            await runGit(["commit", "-m", msg], cwd);
            if (proceedAction === "Commit & Push") {
              await runGit(["push"], cwd);
              vscode.window.showInformationMessage(
                "Smart Commit: Successfully committed and pushed to remote!",
              );
            } else {
              vscode.window.showInformationMessage(
                "Smart Commit: Changes committed locally!",
              );
            }
            repo.inputBox.value = "";
            notifyAllViews({ commitText: "" });
          } catch (err) {
            vscode.window.showErrorMessage(
              `Smart Commit Push Error: ${err.message}`,
            );
          }
        },
      );
    },
  );

  // 6. Command: Safe Branch Sync & Push
  const disposableSyncToBranch = vscode.commands.registerCommand(
    "smartCommit.syncToBranch",
    async (arg) => {
      const repo = getTargetRepository(arg);
      if (!repo) {
        vscode.window.showErrorMessage("No active Git repository found.");
        return;
      }

      const cwd = repo.rootUri.fsPath;

      // A. Check clean working tree
      try {
        const status = (await runGit(["status", "--short"], cwd)).trim();
        if (status) {
          vscode.window.showWarningMessage(
            "Smart Git: Please commit or stash your working tree changes before syncing branches.",
          );
          return;
        }
      } catch (e) {}

      // B. Get current and target branches
      let currentBranch = "";
      try {
        currentBranch = (
          await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
        ).trim();
      } catch (e) {
        currentBranch = "HEAD";
      }

      const branches = await getBranches(cwd, currentBranch);
      if (branches.length === 0) {
        vscode.window.showInformationMessage(
          "No other branches found to sync with.",
        );
        return;
      }

      const targetBranch = await vscode.window.showQuickPick(branches, {
        placeHolder: `Select target branch to sync "${currentBranch}" changes into:`,
        title: "Smart Git: Safe Branch Sync & Push",
      });

      if (!targetBranch) return;

      // C. Dry-run conflict & security check
      let conflictCheck;
      let diffBody = "";
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Smart Git: Checking conflicts and security for "${targetBranch}"...`,
          cancellable: false,
        },
        async () => {
          try {
            conflictCheck = await checkMergeConflicts(
              cwd,
              currentBranch,
              targetBranch,
            );
            try {
              diffBody = await runGitDiffFiltered(["diff", `${targetBranch}...HEAD`], cwd);
            } catch (e) {
              diffBody = "";
            }
          } catch (e) {
            conflictCheck = { hasConflicts: false, mergeBase: "", output: "" };
          }
        },
      );

      if (conflictCheck && conflictCheck.hasConflicts) {
        vscode.window.showErrorMessage(
          `Cannot sync to "${targetBranch}": Merge conflicts detected! Opening AI Conflict Advisor...`,
        );
        vscode.commands.executeCommand("smartCommit.compareBranches", arg);
        return;
      }

      const securityIssues = scanDiffForSecurityIssues(diffBody);
      if (securityIssues.length > 0) {
        const issueList = securityIssues
          .slice(0, 3)
          .map((i) => `• ${i.type} in ${i.file}`)
          .join("\n");
        const proceed = await vscode.window.showWarningMessage(
          `Smart Git: Security Warning before syncing to "${targetBranch}"`,
          {
            modal: true,
            detail: `Detected sensitive data in changes:\n${issueList}\n\nDo you want to proceed with sync and push?`,
          },
          "Sync & Push Anyway",
        );
        if (proceed !== "Sync & Push Anyway") return;
      }

      const isReleaseBranch = /publish|release/i.test(targetBranch);
      const autoBump = getSetting("autoBumpVersion") !== false;
      const pkgInfo =
        isReleaseBranch && autoBump ? getPackageJsonInfo(cwd) : null;

      let targetVersion = null;
      if (pkgInfo) {
        let commitLog = "";
        try {
          commitLog = await runGit(
            ["log", `${targetBranch}..HEAD`, "--oneline"],
            cwd,
          );
        } catch (e) {}
        const versionPlan = calculateNextVersions(pkgInfo.version, commitLog);

        const detailMsg = `Branches: "${currentBranch}" ➔ "${targetBranch}"\nAuto Version Bump: v${versionPlan.currentVersion} ➔ v${versionPlan.recommendedVersion} (${versionPlan.recommendedType.toUpperCase()})\nStatus: 0 conflicts, 0 security warnings.\n\nWould you like to release v${versionPlan.recommendedVersion} to "${targetBranch}" and push to remote?`;

        const choice = await vscode.window.showInformationMessage(
          "Smart Git: Ready to Sync & Publish",
          {
            modal: true,
            detail: detailMsg,
          },
          `Sync & Publish (v${versionPlan.recommendedVersion})`,
          "Customize Version...",
        );

        if (!choice) return;

        if (choice === `Sync & Publish (v${versionPlan.recommendedVersion})`) {
          targetVersion = versionPlan.recommendedVersion;
          await applyVersionBump(pkgInfo, targetVersion, cwd);
        } else if (choice === "Customize Version...") {
          const custom = await promptVersionSelection(versionPlan);
          if (custom === undefined) return;
          if (custom) {
            targetVersion = custom;
            await applyVersionBump(pkgInfo, targetVersion, cwd);
          }
        }
      } else {
        const choice = await vscode.window.showInformationMessage(
          `Smart Git: Zero conflicts! Sync "${currentBranch}" into "${targetBranch}"?`,
          {
            modal: true,
            detail: `This operation will:\n1. Switch to "${targetBranch}"\n2. Merge latest changes from "${currentBranch}"\n3. Push to remote origin\n4. Switch back to "${currentBranch}"`,
          },
          "Sync & Push Now",
        );
        if (choice !== "Sync & Push Now") return;
      }

      await executeBranchSyncAndPush(
        cwd,
        currentBranch,
        targetBranch,
        targetVersion,
      );
    },
  );

  // 7. Command: Generate Pull Request Description
  const disposableGeneratePR = vscode.commands.registerCommand(
    "smartCommit.generatePR",
    async (arg) => {
      const repo = getTargetRepository(arg);
      if (!repo) {
        vscode.window.showErrorMessage("No active Git repository found.");
        return;
      }

      const cwd = repo.rootUri.fsPath;
      const ctx = await resolveProviderContext();
      if (!ctx) return;
      const { provider, apiKey, modelOverride } = ctx;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Smart Commit: Generating PR Description...",
          cancellable: false,
        },
        async () => {
          try {
            const currentBranch = (
              await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
            ).trim();

            let baseBranch = getSetting("baseBranch");
            if (!baseBranch) {
              const branchOutput = await runGit(["branch", "-a"], cwd).catch(
                () => "",
              );
              if (
                branchOutput.includes("remotes/origin/main") ||
                branchOutput.includes("main")
              ) {
                baseBranch = "main";
              } else if (
                branchOutput.includes("remotes/origin/master") ||
                branchOutput.includes("master")
              ) {
                baseBranch = "master";
              } else {
                baseBranch = "main";
              }
            }

            let commitLog = "";
            try {
              commitLog = await runGit(
                ["log", `${baseBranch}..HEAD`, "--oneline", "-n", "50"],
                cwd,
              );
            } catch (e) {
              commitLog = await runGit(
                ["log", "-n", "10", "--oneline"],
                cwd,
              ).catch(() => "");
            }

            let diffStat = "";
            try {
              diffStat = await runGit(
                ["diff", `${baseBranch}...HEAD`, "--stat"],
                cwd,
              );
            } catch (e) {
              diffStat = await runGit(["diff", "--stat"], cwd).catch(() => "");
            }

            let diffBody = "";
            try {
              diffBody = await runGitDiffFiltered(["diff", `${baseBranch}...HEAD`], cwd);
            } catch (e) {
              diffBody = await runGitDiffFiltered(["diff"], cwd).catch(() => "");
            }

            if (diffBody.length > 30000) {
              diffBody =
                diffBody.slice(0, 30000) + "\n\n[Diff truncated for length...]";
            }

            const prPrompt = `Current Branch: ${currentBranch}
Target Base Branch: ${baseBranch}

COMMITS IN BRANCH:
${commitLog || "(no commits found)"}

CHANGES SUMMARY:
${diffStat || "(no summary)"}

CODE DIFF:
${diffBody || "(no diff)"}

Please generate the full Pull Request description:`;

            let prMarkdown = await executeAiCompletion(
              provider,
              apiKey,
              modelOverride,
              prPrompt,
              buildPrSystemPrompt(),
              1200,
            );

            if (!prMarkdown) {
              vscode.window.showWarningMessage(
                "Smart Commit: Empty response from AI.",
              );
              return;
            }

            await vscode.env.clipboard.writeText(prMarkdown);

            const doc = await vscode.workspace.openTextDocument({
              content: prMarkdown,
              language: "markdown",
            });
            await vscode.window.showTextDocument(doc, { preview: false });

            vscode.window.showInformationMessage(
              "Smart Commit: PR Description generated and copied to clipboard!",
            );
          } catch (err) {
            vscode.window.showErrorMessage(
              `Smart Commit PR Error: ${err.message}`,
            );
          }
        },
      );
    },
  );

  // 8. Command: Compare Branches & AI Conflict Advisor
  const disposableCompare = vscode.commands.registerCommand(
    "smartCommit.compareBranches",
    async (arg) => {
      const repo = getTargetRepository(arg);
      if (!repo) {
        vscode.window.showErrorMessage("No active Git repository found.");
        return;
      }

      const cwd = repo.rootUri.fsPath;
      const ctx = await resolveProviderContext();
      if (!ctx) return;
      const { provider, apiKey, modelOverride } = ctx;

      let currentBranch = "";
      try {
        currentBranch = (
          await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
        ).trim();
      } catch (e) {
        currentBranch = "HEAD";
      }

      const branches = await getBranches(cwd, currentBranch);
      if (branches.length === 0) {
        vscode.window.showInformationMessage(
          "No other branches found to compare with.",
        );
        return;
      }

      const selectedTarget = await vscode.window.showQuickPick(branches, {
        placeHolder: `Select branch to compare against "${currentBranch}":`,
        title: "Smart Git: Branch Comparator & Conflict Advisor",
      });

      if (!selectedTarget) return;

      let postCompareAction = null;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Smart Git: Comparing "${currentBranch}" vs "${selectedTarget}" & scanning security...`,
          cancellable: false,
        },
        async () => {
          try {
            const conflictCheck = await checkMergeConflicts(
              cwd,
              currentBranch,
              selectedTarget,
            );

            let commitLog = "";
            try {
              commitLog = await runGit(
                ["log", `${selectedTarget}..HEAD`, "--oneline", "-n", "30"],
                cwd,
              );
            } catch (e) {
              commitLog = await runGit(
                ["log", "-n", "10", "--oneline"],
                cwd,
              ).catch(() => "");
            }

            let commitCount = 0;
            try {
              const countStr = await runGit(
                ["rev-list", "--count", `${selectedTarget}..HEAD`],
                cwd,
              );
              commitCount = parseInt(countStr.trim(), 10) || 0;
            } catch (e) {
              commitCount = 0;
            }

            let diffStat = "";
            try {
              diffStat = await runGit(
                ["diff", `${selectedTarget}...HEAD`, "--stat"],
                cwd,
              );
            } catch (e) {
              diffStat = "";
            }

            let diffBody = "";
            try {
              diffBody = await runGitDiffFiltered(
                ["diff", `${selectedTarget}...HEAD`],
                cwd,
              );
            } catch (e) {
              diffBody = "";
            }

            const securityIssues = scanDiffForSecurityIssues(diffBody);

            let reportMarkdown = "";

            if (conflictCheck.hasConflicts) {
              let conflictDetails = conflictCheck.output;
              if (conflictDetails.length > 25000) {
                conflictDetails =
                  conflictDetails.slice(0, 25000) +
                  "\n\n[Conflict log truncated...]";
              }

              const prompt = `Current Working Branch: ${currentBranch}
Target Merge Branch: ${selectedTarget}
Merge Base: ${conflictCheck.mergeBase}

SIMULATED MERGE CONFLICT LOG:
${conflictDetails}

FILE CHANGES STAT:
${diffStat}

Analyze the conflicts and provide the complete resolution guide:`;

              reportMarkdown = await executeAiCompletion(
                provider,
                apiKey,
                modelOverride,
                prompt,
                CONFLICT_SYSTEM_PROMPT,
                1500,
              );

              const doc = await vscode.workspace.openTextDocument({
                content: reportMarkdown,
                language: "markdown",
              });
              await vscode.window.showTextDocument(doc, { preview: false });

              postCompareAction = { type: "conflict" };
            } else {
              let securityNotice = "";
              if (securityIssues.length > 0) {
                securityNotice =
                  `## Security Notice\nDetected ${securityIssues.length} potential secret(s) or sensitive string(s) in the diff:\n` +
                  securityIssues
                    .map((i) => `- **${i.type}** in \`${i.file}\``)
                    .join("\n") +
                  "\n\n";
              }

              const prompt = `Current Working Branch: ${currentBranch}
Target Base Branch: ${selectedTarget}
${securityIssues.length > 0 ? `SECURITY WARNING: Found ${securityIssues.length} potential secrets in diff.` : "SECURITY: Clean, no leaked credentials detected."}

COMMITS UNIQUE TO ${currentBranch}:
${commitLog || "(no new commits)"}

MODIFIED FILES STAT:
${diffStat || "(no files modified)"}

DIFF DETAILS:
${diffBody.slice(0, 25000) || "(no diff)"}

Write a comprehensive branch comparison and architecture report:`;

              reportMarkdown = await executeAiCompletion(
                provider,
                apiKey,
                modelOverride,
                prompt,
                BRANCH_COMPARE_SYSTEM_PROMPT,
                1500,
              );

              if (securityNotice) {
                reportMarkdown = securityNotice + reportMarkdown;
              }

              const doc = await vscode.workspace.openTextDocument({
                content: reportMarkdown,
                language: "markdown",
              });
              await vscode.window.showTextDocument(doc, { preview: false });

              postCompareAction = {
                type: securityIssues.length > 0 ? "security" : "clean",
                securityIssues,
                commitCount,
              };
            }
          } catch (err) {
            vscode.window.showErrorMessage(`Smart Git Error: ${err.message}`);
          }
        },
      );

      if (!postCompareAction) return;

      if (postCompareAction.type === "conflict") {
        vscode.window
          .showWarningMessage(
            `Smart Git: Merge conflicts detected between "${currentBranch}" and "${selectedTarget}". Pushing is blocked. Review AI Resolution Guide in editor.`,
            "Open Source Control",
          )
          .then((act) => {
            if (act === "Open Source Control") {
              vscode.commands.executeCommand("workbench.view.scm");
            }
          });
      } else if (postCompareAction.type === "security") {
        const issueList = postCompareAction.securityIssues
          .slice(0, 3)
          .map((i) => `• ${i.type} in ${i.file}`)
          .join("\n");
        const act = await vscode.window.showWarningMessage(
          `Smart Git: Security Warning detected between "${currentBranch}" and "${selectedTarget}"`,
          {
            modal: true,
            detail: `Found ${postCompareAction.securityIssues.length} potential secret(s) in branch changes:\n${issueList}\n\nReview the report before pushing to prevent credential leaks.`,
          },
          `Sync & Push to "${selectedTarget}" Anyway`,
          "Generate PR Description",
        );

        if (act === `Sync & Push to "${selectedTarget}" Anyway`) {
          await executeBranchSyncAndPush(cwd, currentBranch, selectedTarget);
        } else if (act === "Generate PR Description") {
          vscode.commands.executeCommand("smartCommit.generatePR", arg);
        }
      } else if (postCompareAction.type === "clean") {
        const isReleaseBranch = /publish|release/i.test(selectedTarget);
        const autoBump = getSetting("autoBumpVersion") !== false;
        const pkgInfo =
          isReleaseBranch && autoBump ? getPackageJsonInfo(cwd) : null;

        if (pkgInfo) {
          let commitLog = "";
          try {
            commitLog = await runGit(
              ["log", `${selectedTarget}..HEAD`, "--oneline"],
              cwd,
            );
          } catch (e) {}
          const versionPlan = calculateNextVersions(pkgInfo.version, commitLog);

          const detailMsg = `Branches: "${currentBranch}" ➔ "${selectedTarget}"\nAuto Version Bump: v${versionPlan.currentVersion} ➔ v${versionPlan.recommendedVersion} (${versionPlan.recommendedType.toUpperCase()})\nCommits ahead: ${postCompareAction.commitCount}\nStatus: 0 conflicts, 0 security warnings.\n\nWould you like to release v${versionPlan.recommendedVersion} to "${selectedTarget}" and push to remote now?`;

          const act = await vscode.window.showInformationMessage(
            "Smart Git: Ready to Sync & Publish",
            {
              modal: true,
              detail: detailMsg,
            },
            `Sync & Publish (v${versionPlan.recommendedVersion})`,
            "Customize Version...",
            "Generate PR Description",
          );

          if (act === `Sync & Publish (v${versionPlan.recommendedVersion})`) {
            await applyVersionBump(
              pkgInfo,
              versionPlan.recommendedVersion,
              cwd,
            );
            await executeBranchSyncAndPush(
              cwd,
              currentBranch,
              selectedTarget,
              versionPlan.recommendedVersion,
            );
          } else if (act === "Customize Version...") {
            const custom = await promptVersionSelection(versionPlan);
            if (custom !== undefined) {
              if (custom) {
                await applyVersionBump(pkgInfo, custom, cwd);
              }
              await executeBranchSyncAndPush(
                cwd,
                currentBranch,
                selectedTarget,
                custom,
              );
            }
          } else if (act === "Generate PR Description") {
            vscode.commands.executeCommand("smartCommit.generatePR", arg);
          }
        } else {
          const detailMsg =
            postCompareAction.commitCount > 0
              ? `Branches: "${currentBranch}" ➔ "${selectedTarget}"\nCommits ahead: ${postCompareAction.commitCount}\nStatus: 0 conflicts, 0 security warnings.\n\nWould you like to sync "${currentBranch}" into "${selectedTarget}" and push to remote now?`
              : `Branches: "${currentBranch}" ➔ "${selectedTarget}"\nStatus: "${selectedTarget}" is already up to date with "${currentBranch}" (0 new commits).\n0 conflicts, 0 security warnings.`;

          const act = await vscode.window.showInformationMessage(
            "Smart Git: Ready to Sync & Push",
            {
              modal: true,
              detail: detailMsg,
            },
            `Sync & Push to "${selectedTarget}"`,
            "Generate PR Description",
          );

          if (act === `Sync & Push to "${selectedTarget}"`) {
            await executeBranchSyncAndPush(cwd, currentBranch, selectedTarget);
          } else if (act === "Generate PR Description") {
            vscode.commands.executeCommand("smartCommit.generatePR", arg);
          }
        }
      }
    },
  );

  // 9. Command: Select AI Provider
  const disposableSelectProvider = vscode.commands.registerCommand(
    "smartCommit.selectProvider",
    async () => {
      const currentProvider = getSetting("provider") || "gemini";
      const items = [
        {
          label: "$(sparkle) Google Gemini",
          description: "Free tier available via Google AI Studio (gemini-3.8-flash)",
          value: "gemini",
        },
        {
          label: "$(copilot) Built-in IDE AI (Copilot)",
          description: "Zero API key — reuses active VS Code Language Model (VS Code 1.90+)",
          value: "vscode-lm",
        },
        {
          label: "$(zap) Groq",
          description: "Free tier available — ultra-fast LPU inference (llama-3.3-70b)",
          value: "groq",
        },
        {
          label: "$(server) Ollama",
          description: "100% Free & Offline (Local, zero API key)",
          value: "ollama",
        },
        {
          label: "$(comment-discussion) Anthropic Claude",
          description: "Fast & accurate Claude Haiku 5.5",
          value: "claude",
        },
        {
          label: "$(hubot) OpenAI",
          description: "Standard GPT-4o-mini / GPT-4o",
          value: "openai",
        },
        {
          label: "$(globe) OpenRouter",
          description: "Access 200+ models through a single API key",
          value: "openrouter",
        },
        {
          label: "$(circuit-board) DeepSeek",
          description: "Low-cost coding model (deepseek-chat)",
          value: "deepseek",
        },
        {
          label: "$(rocket) Grok (xAI)",
          description: "Fast non-reasoning Grok 4.20 by xAI",
          value: "grok",
        },
        {
          label: "$(plug) Custom OpenAI-Compatible",
          description: "LM Studio, Azure OpenAI, vLLM, LiteLLM, or private proxy",
          value: "custom",
        },
        {
          label: "$(key) Manage Encrypted API Keys...",
          description: "Add, update, or remove keys in VS Code Secret Storage",
          value: "__manage_keys__",
        },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        title: "Smart Git: Select Active AI Provider",
        placeHolder: `Current provider: ${currentProvider}`,
      });

      if (!selected) return;

      if (selected.value === "__manage_keys__") {
        await vscode.commands.executeCommand("smartCommit.manageApiKeys");
        return;
      }

      await vscode.workspace
        .getConfiguration("smartCommit")
        .update(
          "provider",
          selected.value,
          vscode.ConfigurationTarget.Global,
        );
      vscode.window.showInformationMessage(
        `Smart Git: Switched AI provider to ${selected.label.replace(/\$\([^)]+\)\s*/, "")}`,
      );
      notifyAllViews();
    },
  );

  // 9b. Command: Manage API Keys in Encrypted Secret Storage
  const disposableManageApiKeys = vscode.commands.registerCommand(
    "smartCommit.manageApiKeys",
    async () => {
      await migrateAllLegacyApiKeys(true);

      const items = [];
      for (const [providerId, meta] of Object.entries(SECRET_PROVIDERS)) {
        const existing = await getStoredApiKey(providerId);
        items.push({
          label: `$(key) ${meta.label}`,
          description: existing
            ? "Configured (Encrypted Secret Storage)"
            : meta.optionalKey
              ? "Not set (Optional)"
              : "Not configured",
          providerId,
          meta,
          hasKey: Boolean(existing),
        });
      }

      const chosen = await vscode.window.showQuickPick(items, {
        title: "Smart Git: Manage API Keys (Encrypted Secret Storage)",
        placeHolder: "Select a provider to add, update, or remove its API key",
      });
      if (!chosen) return;

      const actions = [
        {
          label: chosen.hasKey ? "$(edit) Update API Key" : "$(add) Set API Key",
          action: "set",
        },
      ];
      if (chosen.meta.keyUrl) {
        actions.push({
          label: chosen.meta.isFreeTier
            ? "$(link-external) Open Key Portal (Free Tier)"
            : "$(link-external) Open Key Portal",
          action: "portal",
        });
      }
      if (chosen.hasKey) {
        actions.push({
          label: "$(trash) Remove Stored API Key",
          action: "delete",
        });
      }

      const act = await vscode.window.showQuickPick(actions, {
        title: `Smart Git: ${chosen.meta.label} API Key`,
        placeHolder: "Choose an action",
      });
      if (!act) return;

      if (act.action === "delete") {
        await storeApiKey(chosen.providerId, "");
        vscode.window.showInformationMessage(
          `Smart Git: Removed ${chosen.meta.label} API key from Secret Storage.`,
        );
        return;
      }

      if (act.action === "portal" && chosen.meta.keyUrl) {
        await vscode.env.openExternal(vscode.Uri.parse(chosen.meta.keyUrl));
      }

      const entered = await vscode.window.showInputBox({
        title: `Smart Git: Save ${chosen.meta.label} API Key`,
        prompt: `Paste your ${chosen.meta.label} API key (stored encrypted in VS Code Secret Storage)`,
        password: true,
        ignoreFocusOut: true,
      });

      if (entered && entered.trim()) {
        await storeApiKey(chosen.providerId, entered.trim());
        vscode.window.showInformationMessage(
          `Smart Git: Saved ${chosen.meta.label} API key securely!`,
        );
      }
    },
  );

  // 10. Activity Bar Badge Carrier & Webview Providers for Activity Bar & Source Control View
  let badgeTreeView = null;
  try {
    if (typeof vscode.window.createTreeView === "function") {
      badgeTreeView = vscode.window.createTreeView("smartCommit.badgeView", {
        treeDataProvider: {
          getTreeItem: (item) => item,
          getChildren: () => [],
        },
      });
      context.subscriptions.push(badgeTreeView);
    }
  } catch (e) {}

  let lastBadgeCount = 0;
  let lastBadgeRepoName = "";
  let actionsViewProvider = null;

  function clearViewBadge(view, deferUndefined = false) {
    if (!view) return;
    try {
      if (view.badge === undefined) return;
      // Workaround for VS Code < 1.116 / forks (missing microsoft/vscode#331019):
      // WebviewViewPane.updateBadge(undefined) fails to clear its activity, leaving the old count stuck.
      // Setting value: 0 immediately replaces and hides the NumberBadge in compositeBarActions,
      // then setting undefined clears the activity cleanly on newer VS Code builds.
      view.badge = { value: 0, tooltip: "" };
      if (deferUndefined) {
        setTimeout(() => {
          if (lastBadgeCount === 0 && view === actionsViewProvider?._view) {
            try {
              view.badge = undefined;
            } catch (e) {}
          }
        }, 50);
      } else {
        view.badge = undefined;
      }
    } catch (e) {}
  }

  function applyActivityBarBadge(count, repoName = "") {
    const safeCount =
      Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    lastBadgeCount = safeCount;
    lastBadgeRepoName = repoName || "";

    const badge =
      safeCount > 0
        ? {
            value: safeCount,
            tooltip: repoName
              ? `${safeCount} pending change${safeCount === 1 ? "" : "s"} (${repoName})`
              : `${safeCount} pending change${safeCount === 1 ? "" : "s"}`,
          }
        : undefined;

    if (actionsViewProvider && actionsViewProvider._view) {
      // Once the Activity Bar webview is resolved, it owns the badge alone (prevents double-counting)
      clearViewBadge(badgeTreeView, false);
      if (badge) {
        try {
          actionsViewProvider._view.badge = badge;
        } catch (e) {}
      } else {
        clearViewBadge(actionsViewProvider._view, true);
      }
    } else if (badgeTreeView) {
      if (badge) {
        try {
          badgeTreeView.badge = badge;
        } catch (e) {}
      } else {
        clearViewBadge(badgeTreeView, false);
      }
    }
  }

  async function refreshActivityBarBadge() {
    try {
      const repo = getTargetRepository();
      if (!repo) {
        applyActivityBarBadge(0, "");
        return;
      }
      const cwd = repo.rootUri.fsPath;
      const repoName = path.basename(cwd);
      const stat = await runGit(["status", "--porcelain=v1", "-u"], cwd);
      const count = stat.split("\n").filter((l) => l.length >= 3).length;
      applyActivityBarBadge(count, repoName);
    } catch (e) {}
  }

  actionsViewProvider = new SmartGitViewProvider(context.extensionUri, {
    onChangesCount: (count, repoName) => applyActivityBarBadge(count, repoName),
    onDispose: () => applyActivityBarBadge(lastBadgeCount, lastBadgeRepoName),
  });
  const actionsViewScmProvider = new SmartGitViewProvider(context.extensionUri);

  const viewDisposable1 = vscode.window.registerWebviewViewProvider(
    "smartCommit.actionsView",
    actionsViewProvider,
  );
  const viewDisposable2 = vscode.window.registerWebviewViewProvider(
    "smartCommit.actionsViewScm",
    actionsViewScmProvider,
  );

  function notifyAllViews(extra = {}) {
    if (actionsViewProvider._view) {
      actionsViewProvider.updateState(extra);
    } else {
      refreshActivityBarBadge();
    }
    actionsViewScmProvider.updateState(extra);
  }

  globalNotifyAllViews = notifyAllViews;

  // Real-time automatic Git & file changes synchronization (keeps Activity Bar badge live even when hidden)
  let autoRefreshTimer = null;
  function debouncedAutoRefresh() {
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    autoRefreshTimer = setTimeout(() => {
      const isVisible =
        (actionsViewProvider._view && actionsViewProvider._view.visible) ||
        (actionsViewScmProvider._view && actionsViewScmProvider._view.visible);
      if (isVisible) {
        notifyAllViews();
      } else {
        refreshActivityBarBadge();
      }
    }, 350);
  }

  // 1. Hook into VS Code Git extension repository state changes
  function setupGitListeners() {
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension) return;
    const gitApi = gitExtension.exports?.getAPI ? gitExtension.exports.getAPI(1) : null;
    if (!gitApi) return;

    const subscribedRepos = new Set();
    const subscribeRepo = (repo) => {
      if (!repo || !repo.state || subscribedRepos.has(repo.rootUri.fsPath)) return;
      subscribedRepos.add(repo.rootUri.fsPath);
      context.subscriptions.push(
        repo.state.onDidChange(() => {
          debouncedAutoRefresh();
        })
      );
    };

    if (gitApi.repositories) {
      gitApi.repositories.forEach(subscribeRepo);
    }

    context.subscriptions.push(
      gitApi.onDidOpenRepository((repo) => {
        subscribeRepo(repo);
        debouncedAutoRefresh();
      })
    );

    if (gitApi.onDidCloseRepository) {
      context.subscriptions.push(
        gitApi.onDidCloseRepository(() => {
          debouncedAutoRefresh();
        })
      );
    }

    refreshActivityBarBadge();
  }

  const gitExt = vscode.extensions.getExtension("vscode.git");
  if (gitExt) {
    if (gitExt.isActive) {
      setupGitListeners();
    } else {
      gitExt.activate().then(setupGitListeners, () => {});
    }
  }

  // 2. Automatically refresh when files are saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === "file") {
        debouncedAutoRefresh();
      }
    })
  );

  // 3. Automatically refresh when files are created, deleted, or renamed in workspace
  context.subscriptions.push(
    vscode.workspace.onDidCreateFiles(() => debouncedAutoRefresh()),
    vscode.workspace.onDidDeleteFiles(() => debouncedAutoRefresh()),
    vscode.workspace.onDidRenameFiles(() => debouncedAutoRefresh())
  );

  // 4. Automatically refresh when switching active editor tabs
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document && editor.document.uri.scheme === "file") {
        debouncedAutoRefresh();
      }
    })
  );

  // 11. Command: Select Active Repository
  const disposableSelectRepo = vscode.commands.registerCommand(
    "smartCommit.selectRepository",
    async () => {
      const gitExtension = vscode.extensions.getExtension("vscode.git");
      if (!gitExtension || !gitExtension.isActive) return;
      const api = gitExtension.exports?.getAPI?.(1);
      if (!api || !api.repositories || api.repositories.length <= 1) {
        vscode.window.showInformationMessage(
          "Smart Git: Only one repository open in workspace.",
        );
        return;
      }

      const items = api.repositories.map((r) => {
        const name = path.basename(r.rootUri.fsPath);
        const branch = r.state.HEAD?.name || "HEAD";
        const changes =
          (r.state.workingTreeChanges?.length || 0) +
          (r.state.indexChanges?.length || 0);
        return {
          label: `$(repo) ${name}`,
          description: `branch: ${branch} • ${changes} change(s)`,
          repo: r,
        };
      });

      const chosen = await vscode.window.showQuickPick(items, {
        title: "Smart Git: Select Active Repository",
        placeHolder: "Select repository to target for AI commits & git actions",
      });

      if (chosen) {
        currentTargetRepoUri = chosen.repo.rootUri.fsPath;
        notifyAllViews();
        vscode.window.showInformationMessage(
          `Smart Git: Switched active repository to "${path.basename(chosen.repo.rootUri.fsPath)}"`,
        );
      }
    },
  );

  // 12. Command: Commit & Push from Webview
  const disposableCommitAndPushFromView = vscode.commands.registerCommand(
    "smartCommit.commitAndPushFromView",
    async (customMsg) => {
      const repo = getTargetRepository();
      if (!repo) {
        vscode.window.showErrorMessage("No active Git repository found.");
        return;
      }

      const cwd = repo.rootUri.fsPath;
      let msg = (customMsg || (repo.inputBox && repo.inputBox.value) || "").trim();

      if (!msg) {
        try {
          const statusRaw = (await runGit(["status", "--porcelain=v1", "-u"], cwd)).trim();
          if (!statusRaw) {
            return vscode.commands.executeCommand("smartCommit.pushCommits");
          }
        } catch (e) {}
      }

      if (!msg) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Smart Commit: Generating commit message...",
            cancellable: false,
          },
          async () => {
            try {
              const stagedCheck = await runGit(["diff", "--cached"], cwd);
              if (!stagedCheck.trim()) {
                await runGit(["add", "-A"], cwd);
              }
              msg = await generateCommitMessage(repo, false);
              if (msg) {
                repo.inputBox.value = msg;
                notifyAllViews({ commitText: msg });
              }
            } catch (err) {
              vscode.window.showErrorMessage(
                `Smart Commit Error: ${err.message}`,
              );
            }
          },
        );
      }

      if (!msg) return;

      const confirmPush = getSetting("confirmBeforePush");
      let proceedAction = "Commit & Push";

      if (confirmPush !== false) {
        const firstLine = msg.split("\n")[0];
        const choice = await vscode.window.showInformationMessage(
          "Smart Commit: Commit & Push to Remote?",
          {
            modal: true,
            detail: `Message:\n"${firstLine}"\n\nWould you like to commit and push these changes to remote now?`,
          },
          "Commit & Push",
          "Only Commit",
        );

        if (!choice) return;
        proceedAction = choice;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title:
            proceedAction === "Commit & Push"
              ? "Smart Commit: Committing and pushing to remote..."
              : "Smart Commit: Committing changes...",
          cancellable: false,
        },
        async () => {
          try {
            const stagedCheck = (await runGit(["diff", "--cached"], cwd)).trim();
            if (!stagedCheck) {
              await runGit(["add", "-A"], cwd);
            }
            await runGit(["commit", "-m", msg], cwd);
            if (proceedAction === "Commit & Push") {
              await runGit(["push"], cwd);
              vscode.window.showInformationMessage(
                "Smart Commit: Successfully committed and pushed to remote!",
              );
            } else {
              vscode.window.showInformationMessage(
                "Smart Commit: Changes committed locally!",
              );
            }
            repo.inputBox.value = "";
            notifyAllViews({ commitText: "" });
          } catch (err) {
            vscode.window.showErrorMessage(
              `Smart Commit Push Error: ${err.message}`,
            );
          }
        },
      );
    },
  );

  // 13. Command: Commit Only (without push)
  const disposableCommitOnly = vscode.commands.registerCommand(
    "smartCommit.commitOnly",
    async (customMsg) => {
      try {
        const repo = getTargetRepository();
        if (!repo) {
          vscode.window.showErrorMessage("No active Git repository found.");
          return;
        }
        const cwd = repo.rootUri.fsPath;
        let commitMsg = (customMsg || (repo.inputBox && repo.inputBox.value) || "").trim();
        if (!commitMsg) {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Smart Git: Generating commit message with AI...",
              cancellable: false,
            },
            async () => {
              try {
                const stagedCheck = (await runGit(["diff", "--cached"], cwd)).trim();
                if (!stagedCheck) {
                  await runGit(["add", "-A"], cwd);
                }
                commitMsg = await generateCommitMessage(repo, false);
                if (commitMsg && repo.inputBox) {
                  repo.inputBox.value = commitMsg;
                }
              } catch (e) {
                vscode.window.showErrorMessage(`Smart Git AI Error: ${e.message}`);
              }
            },
          );
        }
        if (!commitMsg) {
          vscode.window.showWarningMessage(
            "Smart Git: Please enter or generate a commit message first.",
          );
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Smart Git: Committing changes locally...",
            cancellable: false,
          },
          async () => {
            const staged = (await runGit(["diff", "--cached"], cwd)).trim();
            if (!staged) {
              await runGit(["add", "-A"], cwd);
            }
            await runGit(["commit", "-m", commitMsg], cwd);
            repo.inputBox.value = "";
            vscode.window.showInformationMessage(
              "Smart Git: Successfully committed changes!",
            );
            notifyAllViews({ commitText: "" });
          },
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Smart Git Commit Error: ${err.message}`,
        );
      }
    },
  );

  // 14. Command: Push Commits to Remote (with auto-upstream)
  const disposablePushCommits = vscode.commands.registerCommand(
    "smartCommit.pushCommits",
    async () => {
      try {
        const repo = getTargetRepository();
        if (!repo) {
          vscode.window.showErrorMessage("No active Git repository found.");
          return;
        }
        const cwd = repo.rootUri.fsPath;
        let branch = "HEAD";
        try {
          branch = (
            await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
          ).trim();
        } catch (e) {}

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Smart Git: Pushing commits on '${branch}' to remote...`,
            cancellable: false,
          },
          async () => {
            try {
              await runGit(["push"], cwd);
              vscode.window.showInformationMessage(
                `Smart Git: Successfully pushed commits to remote!`,
              );
            } catch (err) {
              const errLower = (err.message || "").toLowerCase();
              if (
                errLower.includes("no upstream branch") ||
                errLower.includes("has no upstream") ||
                errLower.includes("upstream")
              ) {
                await runGit(["push", "--set-upstream", "origin", branch], cwd);
                vscode.window.showInformationMessage(
                  `Smart Git: Pushed commits and set upstream to 'origin/${branch}'!`,
                );
              } else {
                throw err;
              }
            }
            if (globalNotifyAllViews) globalNotifyAllViews();
            else if (actionsViewProvider) actionsViewProvider.updateState();
          },
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Smart Git Push Error: ${err.message}`,
        );
      }
    },
  );

  // 15. Command: Undo Last Commit (Soft Reset)
  const disposableUndoCommit = vscode.commands.registerCommand(
    "smartCommit.undoCommit",
    async () => {
      try {
        const repo = getTargetRepository();
        if (!repo) {
          vscode.window.showErrorMessage("No active Git repository found.");
          return;
        }
        const cwd = repo.rootUri.fsPath;

        let lastMsg = "";
        let shortHash = "";
        try {
          lastMsg = (
            await runGit(["log", "-1", "--pretty=format:%B"], cwd)
          ).trim();
          shortHash = (
            await runGit(["log", "-1", "--pretty=format:%h"], cwd)
          ).trim();
        } catch (e) {
          vscode.window.showWarningMessage("Smart Git: No commits found to undo.");
          return;
        }

        await runGit(["reset", "--soft", "HEAD~1"], cwd);

        if (repo.inputBox) {
          repo.inputBox.value = lastMsg;
        }

        vscode.window.showInformationMessage(
          `Smart Git: Undid commit [${shortHash || "HEAD"}]! Changes are staged & message restored to edit or regenerate with AI.`,
        );

        notifyAllViews({ commitText: lastMsg });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Smart Git Undo Error: ${err.message}`,
        );
      }
    },
  );

  // 16. Command: Switch / Checkout Branch
  const disposableSwitchBranch = vscode.commands.registerCommand(
    "smartCommit.switchBranch",
    async (arg) => {
      const repo = getTargetRepository(arg);
      if (!repo) {
        vscode.window.showErrorMessage("No active Git repository found.");
        return;
      }

      const cwd = repo.rootUri.fsPath;
      let currentBranch = "HEAD";
      try {
        currentBranch = (
          await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
        ).trim();
      } catch (e) {}

      let branchesOutput = "";
      try {
        branchesOutput = await runGit(
          ["branch", "-a", "--sort=-committerdate"],
          cwd,
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `Smart Git: Could not list branches: ${e.message}`,
        );
        return;
      }

      const lines = branchesOutput.split("\n");
      const branchItems = [];
      const seen = new Set();

      for (const line of lines) {
        let raw = line.trim();
        if (!raw || raw.includes("->")) continue;
        const isCurrent = raw.startsWith("*");
        if (isCurrent) raw = raw.substring(1).trim();

        let branchName = raw;
        let isRemote = false;
        if (branchName.startsWith("remotes/origin/")) {
          branchName = branchName.replace(/^remotes\/origin\//, "");
          isRemote = true;
        } else if (branchName.startsWith("remotes/")) {
          branchName = branchName.replace(/^remotes\/[^\/]+\//, "");
          isRemote = true;
        }

        if (seen.has(branchName)) continue;
        seen.add(branchName);

        if (branchName === currentBranch) {
          branchItems.unshift({
            label: `$(check) ${branchName}`,
            description: "Current branch",
            branchName,
            isCurrent: true,
          });
        } else {
          branchItems.push({
            label: isRemote
              ? `$(cloud) ${branchName}`
              : `$(git-branch) ${branchName}`,
            description: isRemote ? "Remote branch" : "Local branch",
            branchName,
            isCurrent: false,
          });
        }
      }

      branchItems.push({
        label: "$(plus) Create new branch...",
        description: "Create and switch to a new branch",
        isNew: true,
      });

      const picked = await vscode.window.showQuickPick(branchItems, {
        title: `Smart Git: Switch Branch (${path.basename(cwd)})`,
        placeHolder: `Currently on "${currentBranch}". Select a branch to checkout:`,
      });

      if (!picked || picked.isCurrent) return;

      if (picked.isNew) {
        const newBranchName = await vscode.window.showInputBox({
          title: "Smart Git: Create & Checkout New Branch",
          prompt: "Enter the new branch name",
          placeHolder: "e.g. feat/login, fix/issue-123",
          validateInput: (v) => {
            if (!v || !v.trim()) return "Branch name cannot be empty";
            if (/\s/.test(v)) return "Branch name cannot contain spaces";
            return null;
          },
        });
        if (!newBranchName || !newBranchName.trim()) return;

        try {
          await runGit(["checkout", "-b", newBranchName.trim()], cwd);
          vscode.window.showInformationMessage(
            `Smart Git: Created and switched to new branch "${newBranchName.trim()}"!`,
          );
          notifyAllViews();
        } catch (err) {
          vscode.window.showErrorMessage(
            `Smart Git: Could not create branch: ${err.message}`,
          );
        }
        return;
      }

      try {
        await runGit(["checkout", picked.branchName], cwd);
        vscode.window.showInformationMessage(
          `Smart Git: Switched to branch "${picked.branchName}"!`,
        );
        notifyAllViews();
      } catch (err) {
        vscode.window.showErrorMessage(
          `Smart Git: Could not checkout "${picked.branchName}": ${err.message}`,
        );
      }
    },
  );

  context.subscriptions.push(
    statusBar,
    disposableQuickMenu,
    disposableToggleFast,
    disposableEnableFast,
    disposableDisableFast,
    disposableGenerate,
    disposableCommitAndPush,
    disposableCommitAndPushFromView,
    disposableSyncToBranch,
    disposableGeneratePR,
    disposableCompare,
    disposableSelectProvider,
    disposableManageApiKeys,
    disposableSelectRepo,
    disposableCommitOnly,
    disposablePushCommits,
    disposableUndoCommit,
    disposableSwitchBranch,
    viewDisposable1,
    viewDisposable2,
  );
}

class SmartGitViewProvider {
  constructor(extensionUri, options = {}) {
    this._extensionUri = extensionUri;
    this._view = null;
    this._onChangesCount =
      typeof options.onChangesCount === "function" ? options.onChangesCount : null;
    this._onDispose =
      typeof options.onDispose === "function" ? options.onDispose : null;
  }

  resolveWebviewView(webviewView, context, _token) {
    this._view = webviewView;

    if (typeof webviewView.onDidDispose === "function") {
      webviewView.onDidDispose(() => {
        this._view = null;
        if (this._onDispose) {
          this._onDispose();
        }
      });
    }

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    const iconUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "icon.png"),
    );

    webviewView.webview.html = this._getHtmlForWebview(
      webviewView.webview,
      iconUri,
    );

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case "quickMenu":
          vscode.commands.executeCommand("smartCommit.quickMenu");
          break;
        case "generate":
          vscode.commands.executeCommand("smartCommit.generate");
          break;
        case "commitAndPush":
          vscode.commands.executeCommand("smartCommit.commitAndPushFromView", data.text);
          break;
        case "commitOnly":
          vscode.commands.executeCommand("smartCommit.commitOnly", data.text);
          break;
        case "undoCommit":
          vscode.commands.executeCommand("smartCommit.undoCommit");
          break;
        case "pushCommits":
        case "pushPending":
          vscode.commands.executeCommand("smartCommit.pushCommits");
          break;
        case "selectRepo":
          vscode.commands.executeCommand("smartCommit.selectRepository");
          break;
        case "switchBranch":
          vscode.commands.executeCommand("smartCommit.switchBranch");
          break;
        case "stageFile": {
          try {
            const repo = getTargetRepository();
            if (!repo) break;
            const cwd = repo.rootUri.fsPath;
            await runGit(["add", "--", data.relPath], cwd);
            if (globalNotifyAllViews) globalNotifyAllViews();
            else this.updateState();
          } catch (err) {
            vscode.window.showErrorMessage(
              `Smart Git: Could not stage "${data.relPath}": ${err.message}`,
            );
          }
          break;
        }
        case "unstageFile": {
          try {
            const repo = getTargetRepository();
            if (!repo) break;
            const cwd = repo.rootUri.fsPath;
            try {
              await runGit(["restore", "--staged", "--", data.relPath], cwd);
            } catch (e) {
              await runGit(["reset", "HEAD", "--", data.relPath], cwd);
            }
            if (globalNotifyAllViews) globalNotifyAllViews();
            else this.updateState();
          } catch (err) {
            vscode.window.showErrorMessage(
              `Smart Git: Could not unstage "${data.relPath}": ${err.message}`,
            );
          }
          break;
        }
        case "discardFile": {
          try {
            const repo = getTargetRepository();
            if (!repo) break;
            const cwd = repo.rootUri.fsPath;
            const fileName = path.basename(data.relPath);
            const answer = await vscode.window.showWarningMessage(
              `Are you sure you want to discard changes in "${fileName}"? This cannot be undone.`,
              { modal: true },
              "Discard Changes",
            );
            if (answer !== "Discard Changes") break;

            if (data.status === "U") {
              const fullPath = path.join(cwd, data.relPath);
              if (fs.existsSync(fullPath)) {
                fs.rmSync(fullPath, { recursive: true, force: true });
              }
            } else {
              try {
                await runGit(
                  ["restore", "--staged", "--worktree", "--", data.relPath],
                  cwd,
                );
              } catch (e) {
                await runGit(["checkout", "HEAD", "--", data.relPath], cwd);
              }
            }
            vscode.window.showInformationMessage(
              `Smart Git: Discarded changes in "${fileName}".`,
            );
            if (globalNotifyAllViews) globalNotifyAllViews();
            else this.updateState();
          } catch (err) {
            vscode.window.showErrorMessage(
              `Smart Git: Could not discard "${data.relPath}": ${err.message}`,
            );
          }
          break;
        }
        case "stageAll": {
          try {
            const repo = getTargetRepository();
            if (!repo) break;
            const cwd = repo.rootUri.fsPath;
            await runGit(["add", "-A"], cwd);
            if (globalNotifyAllViews) globalNotifyAllViews();
            else this.updateState();
          } catch (err) {
            vscode.window.showErrorMessage(
              `Smart Git: Could not stage all: ${err.message}`,
            );
          }
          break;
        }
        case "discardAll": {
          try {
            const repo = getTargetRepository();
            if (!repo) break;
            const cwd = repo.rootUri.fsPath;
            const answer = await vscode.window.showWarningMessage(
              `Are you sure you want to DISCARD ALL changes across all files? This cannot be undone.`,
              { modal: true },
              "Discard All Changes",
            );
            if (answer !== "Discard All Changes") break;

            try {
              await runGit(["restore", "--staged", "--worktree", "."], cwd);
            } catch (e) {
              await runGit(["checkout", "HEAD", "--", "."], cwd);
            }
            try {
              await runGit(["clean", "-fd"], cwd);
            } catch (e) {}

            vscode.window.showInformationMessage(
              "Smart Git: Discarded all changes.",
            );
            if (globalNotifyAllViews) globalNotifyAllViews();
            else this.updateState();
          } catch (err) {
            vscode.window.showErrorMessage(
              `Smart Git: Could not discard all: ${err.message}`,
            );
          }
          break;
        }
        case "openFile":
          try {
            const repo = getTargetRepository();
            if (!repo) break;
            const cwd = repo.rootUri.fsPath;
            const filePath = path.join(cwd, data.relPath);
            const fileUri = vscode.Uri.file(filePath);

            if (fs.existsSync(filePath)) {
              const doc = await vscode.workspace.openTextDocument(fileUri);
              await vscode.window.showTextDocument(doc, { preview: true });
            } else {
              vscode.window.showWarningMessage(
                `Smart Git: File not found on disk: ${data.relPath}`,
              );
            }
          } catch (err) {
            vscode.window.showErrorMessage(
              `Smart Git: Could not open file: ${err.message}`,
            );
          }
          break;
        case "openDiff":
          try {
            const repo = getTargetRepository();
            if (!repo) break;
            const cwd = repo.rootUri.fsPath;
            const filePath = path.join(cwd, data.relPath);
            const fileUri = vscode.Uri.file(filePath);

            if (data.status === "U" || data.status === "D") {
              if (fs.existsSync(filePath)) {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                await vscode.window.showTextDocument(doc, { preview: true });
              }
            } else {
              let openedDiff = false;
              try {
                const gitExtension = vscode.extensions.getExtension("vscode.git");
                const gitApi = gitExtension?.exports?.getAPI(1);
                if (gitApi && gitApi.toGitUri) {
                  const headUri = gitApi.toGitUri(fileUri, "HEAD");
                  const title = `${path.basename(data.relPath)} (Working Tree)`;
                  await vscode.commands.executeCommand(
                    "vscode.diff",
                    headUri,
                    fileUri,
                    title,
                  );
                  openedDiff = true;
                }
              } catch (e) {}

              if (!openedDiff && fs.existsSync(filePath)) {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                await vscode.window.showTextDocument(doc, { preview: true });
              }
            }
          } catch (err) {
            vscode.window.showErrorMessage(
              `Smart Git: Could not open diff: ${err.message}`,
            );
          }
          break;
        case "updateCommitText":
          try {
            const repo = getTargetRepository();
            if (repo && repo.inputBox) {
              repo.inputBox.value = data.text || "";
            }
          } catch (e) {}
          break;
        case "syncBranch":
          vscode.commands.executeCommand("smartCommit.syncToBranch");
          break;
        case "generatePR":
          vscode.commands.executeCommand("smartCommit.generatePR");
          break;
        case "compare":
          vscode.commands.executeCommand("smartCommit.compareBranches");
          break;
        case "toggleFastMode":
          vscode.commands.executeCommand("smartCommit.toggleFastPush");
          break;
        case "selectProvider":
          vscode.commands.executeCommand("smartCommit.selectProvider");
          break;
        case "manageApiKeys":
          vscode.commands.executeCommand("smartCommit.manageApiKeys");
          break;
        case "copyText":
          if (data.text) {
            await vscode.env.clipboard.writeText(String(data.text));
            vscode.window.setStatusBarMessage("Smart Git: Copied to clipboard", 2000);
          }
          break;
        case "refresh":
          this.updateState();
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.updateState();
      }
    });

    this.updateState();
  }

  async updateState(extra = {}) {
    if (!this._view) return;
    const provider = getSetting("provider") || "gemini";
    const isFast = getSetting("confirmBeforePush") === false;

    let branch = "HEAD";
    let stagedCount = 0;
    let unstagedCount = 0;
    let outgoingCommits = [];
    let outgoingCount = 0;
    let commitText = extra.commitText !== undefined ? extra.commitText : "";
    let repoName = "";
    let repoCount = 1;
    const files = [];

    try {
      const gitExtension = vscode.extensions.getExtension("vscode.git");
      if (gitExtension && gitExtension.isActive) {
        const api = gitExtension.exports?.getAPI?.(1);
        if (api && api.repositories) {
          repoCount = api.repositories.length;
        }
      }
      const repo = getTargetRepository();
      if (repo) {
        repoName = path.basename(repo.rootUri.fsPath);
        const cwd = repo.rootUri.fsPath;
        branch = (
          await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
        ).trim();
        if (extra.commitText === undefined && repo.inputBox) {
          commitText = repo.inputBox.value || "";
        }
        // Retrieve outgoing (unpushed) commits
        try {
          let logStr = "";
          try {
            logStr = (
              await runGit(
                [
                  "log",
                  "@{u}..HEAD",
                  "--pretty=format:%H%x1f%h%x1f%s%x1f%ar%x1f%an%x1f%B%x1e",
                ],
                cwd,
              )
            ).trim();
          } catch (err1) {
            try {
              logStr = (
                await runGit(
                  [
                    "log",
                    `origin/${branch}..HEAD`,
                    "--pretty=format:%H%x1f%h%x1f%s%x1f%ar%x1f%an%x1f%B%x1e",
                  ],
                  cwd,
                )
              ).trim();
            } catch (err2) {
              const remotes = (
                await runGit(["remote"], cwd).catch(() => "")
              ).trim();
              if (remotes) {
                for (const base of [
                  "origin/main",
                  "origin/master",
                  "origin/HEAD",
                ]) {
                  try {
                    logStr = (
                      await runGit(
                        [
                          "log",
                          `${base}..HEAD`,
                          "--pretty=format:%H%x1f%h%x1f%s%x1f%ar%x1f%an%x1f%B%x1e",
                        ],
                        cwd,
                      )
                    ).trim();
                    if (logStr) break;
                  } catch (e3) {}
                }
              }
            }
          }

          if (logStr) {
            const rawChunks = logStr.split("\x1e").filter(Boolean);
            outgoingCommits = rawChunks.map((chunk) => {
              const parts = chunk.split("\x1f");
              const hash = parts[0] || "";
              const shortHash = parts[1] || (hash ? hash.substring(0, 7) : "");
              const subject = parts[2] || "";
              const time = parts[3] || "";
              const author = parts[4] || "";
              const fullMsg = parts[5] || subject;
              return {
                hash,
                shortHash,
                subject,
                time,
                author,
                fullMsg: fullMsg.trim(),
              };
            });
            outgoingCount = outgoingCommits.length;
          }
        } catch (e) {}

        const stat = await runGit(["status", "--porcelain=v1", "-u"], cwd);
        const lines = stat.split("\n").filter(Boolean);
        lines.forEach((l) => {
          if (l.length < 3) return;
          const x = l[0];
          const y = l[1];
          if (x !== " " && x !== "?") stagedCount++;
          if (y !== " " || x === "?") unstagedCount++;

          let relPath = l.substring(3).trim();
          if (relPath.includes(" -> ")) {
            relPath = relPath.split(" -> ")[1];
          }
          if (relPath.startsWith('"') && relPath.endsWith('"')) {
            relPath = relPath.slice(1, -1);
          }

          let status = "M";
          let isStaged = false;

          if (x === "?" || y === "?") {
            status = "U";
            isStaged = false;
          } else if (x === "A" || y === "A") {
            status = "A";
            isStaged = (x === "A");
          } else if (x === "D" || y === "D") {
            status = "D";
            isStaged = (x === "D");
          } else if (x === "R" || y === "R") {
            status = "R";
            isStaged = true;
          } else {
            status = "M";
            isStaged = (x !== " ");
          }

          const fileName = path.basename(relPath);
          const dirName = path.dirname(relPath);

          files.push({
            fileName,
            dirName: dirName === "." ? "" : dirName,
            relPath,
            status,
            isStaged,
          });
        });
      }
    } catch (e) {}

    const providerLabels = {
      gemini: "Gemini (Free)",
      "vscode-lm": "IDE AI (Copilot)",
      groq: "Groq (Free)",
      ollama: "Ollama (Offline)",
      claude: "Claude",
      openai: "OpenAI",
      openrouter: "OpenRouter",
      deepseek: "DeepSeek",
      grok: "Grok (xAI)",
      custom: "Custom AI",
    };

    if (this._onChangesCount) {
      this._onChangesCount(files.length, repoName);
    }

    this._view.webview.postMessage({
      type: "update",
      provider: providerLabels[provider] || provider,
      isFast,
      repoName,
      repoCount,
      branch,
      stagedCount,
      unstagedCount,
      outgoingCount,
      outgoingCommits,
      commitText,
      files,
    });
  }

  _getHtmlForWebview(webview, iconUri = "") {
    const nonce = crypto.randomBytes(16).toString("hex");
    const cspSource = webview ? webview.cspSource : "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: transparent;
      padding: 10px 8px;
      user-select: none;
    }
    .header-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 10px;
    }
    .brand-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .brand-icon {
      width: 20px;
      height: 20px;
      border-radius: 4px;
      object-fit: cover;
      vertical-align: middle;
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      transition: transform 0.15s ease;
      flex-shrink: 0;
    }
    .brand-icon:hover {
      transform: scale(1.08);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 12px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      cursor: pointer;
      border: 1px solid var(--vscode-contrastBorder, var(--vscode-widget-border, transparent));
      transition: opacity 0.15s ease, transform 0.1s ease;
      white-space: nowrap;
    }
    .pill-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .pill:hover {
      opacity: 0.85;
      transform: translateY(-1px);
    }
    .pill-fast {
      background: #c25e00;
      color: #ffffff;
    }
    .pill-safe {
      background: #1b6ca8;
      color: #ffffff;
    }
    .commit-box-container {
      margin-bottom: 10px;
    }
    .commit-textarea {
      width: 100%;
      min-height: 165px;
      height: 215px;
      padding: 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.45;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
      border-radius: 4px;
      resize: vertical;
      outline: none;
      user-select: text;
    }
    .commit-textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    .commit-box-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      opacity: 0.75;
      margin-top: 3px;
      padding: 0 2px;
    }
    .clear-link {
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
    }
    .clear-link:hover {
      text-decoration: underline;
    }
    .hero-btn {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 9px 10px;
      border-radius: 5px;
      border: 1px solid var(--vscode-contrastBorder, transparent);
      cursor: pointer;
      margin-bottom: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
      font-size: 12px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.14);
      transition: background 0.15s, transform 0.1s;
    }
    .hero-btn:hover {
      background: var(--vscode-button-hoverBackground);
      transform: translateY(-1px);
    }
    .hero-btn:active {
      transform: translateY(0);
    }
    .btn-main {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .btn-svg {
      flex-shrink: 0;
      vertical-align: middle;
    }
    .hero-btn-sub {
      font-size: 10px;
      font-weight: normal;
      opacity: 0.85;
      margin-top: 2px;
    }
    .btn-commit-push {
      background: #0f766e;
      color: #ffffff;
    }
    .btn-commit-push:hover {
      background: #0d9488;
    }
    .btn-commit-only {
      background: var(--vscode-button-secondaryBackground);
      border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border, rgba(128,128,128,0.3)));
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-commit-only:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .btn-row {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
    }
    .btn-row .hero-btn {
      margin-bottom: 0;
      flex: 1;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-bottom: 10px;
    }
    .grid-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 7px 5px;
      border-radius: 5px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,0.3)));
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      transition: all 0.15s;
    }
    .grid-btn:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
      transform: translateY(-1px);
    }
    .grid-btn-full {
      grid-column: span 2;
    }

    /* Outgoing Commits Section */
    .outgoing-container {
      margin: 8px 0;
      border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,0.25)));
      border-radius: 5px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      overflow: hidden;
    }
    .outgoing-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      cursor: pointer;
      user-select: none;
      background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08));
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
    }
    .outgoing-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .outgoing-header-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .outgoing-title {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.5px;
      opacity: 0.9;
    }
    .outgoing-count-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      transition: background 0.15s ease;
    }
    .outgoing-count-badge.has-outgoing {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .outgoing-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .outgoing-push-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .outgoing-push-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .outgoing-list {
      max-height: 180px;
      overflow-y: auto;
      padding: 3px 0;
    }
    .outgoing-list.collapsed {
      display: none;
    }
    .empty-outgoing {
      padding: 10px 8px;
      font-size: 11px;
      opacity: 0.65;
      text-align: center;
      font-style: italic;
    }
    .commit-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px;
      font-size: 11px;
      transition: background 0.1s;
      gap: 8px;
      border-radius: 4px;
    }
    .commit-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .commit-item-left {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      flex: 1;
      overflow: hidden;
      white-space: nowrap;
    }
    .commit-hash {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px;
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
      background: rgba(128, 128, 128, 0.14);
      padding: 1px 4px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .commit-subject {
      font-weight: 500;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }
    .commit-time {
      font-size: 10px;
      opacity: 0.6;
      flex-shrink: 0;
    }
    .commit-actions {
      display: flex;
      align-items: center;
      gap: 3px;
      flex-shrink: 0;
    }
    .commit-action-btn-undo {
      background: rgba(184, 134, 11, 0.14);
      border: 1px solid var(--vscode-editorWarning-foreground, #b8860b);
      color: var(--vscode-editorWarning-foreground, #b8860b);
      border-radius: 3px;
      padding: 2px 6px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      transition: all 0.12s ease;
    }
    .commit-action-btn-undo:hover {
      background: rgba(184, 134, 11, 0.25);
    }

    /* Changed Files Section */
    .changes-container {
      margin: 8px 0;
      border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,0.25)));
      border-radius: 5px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      overflow: hidden;
    }
    .changes-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      cursor: pointer;
      user-select: none;
      background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08));
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
    }
    .changes-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .changes-header-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .chevron {
      font-size: 10px;
      transition: transform 0.15s ease;
      display: inline-block;
      opacity: 0.7;
    }
    .chevron.collapsed {
      transform: rotate(-90deg);
    }
    .changes-title {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.5px;
      opacity: 0.9;
    }
    .changes-count-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .changes-action-btn {
      font-size: 13px;
      opacity: 0.75;
      padding: 2px 5px;
      border-radius: 3px;
      cursor: pointer;
    }
    .changes-action-btn:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.16));
    }
    .changes-action-btn-danger:hover {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #d13438);
      background: rgba(209, 52, 56, 0.15);
    }
    .changes-action-btn-success:hover {
      color: var(--vscode-gitDecoration-untrackedResourceForeground, #2e8b57);
      background: rgba(46, 139, 87, 0.15);
    }
    .files-list {
      max-height: 180px;
      overflow-y: auto;
      padding: 3px 0;
    }
    .files-list.collapsed {
      display: none;
    }
    .file-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 11px;
      transition: background 0.1s;
      gap: 8px;
      border-radius: 4px;
    }
    .file-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .file-info {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      flex: 1;
      overflow: hidden;
      white-space: nowrap;
      cursor: pointer;
    }
    .file-info:hover .file-name {
      text-decoration: underline;
      color: var(--vscode-textLink-foreground);
    }
    .file-name {
      font-weight: 500;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-path {
      font-size: 10px;
      opacity: 0.6;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-actions {
      display: flex;
      align-items: center;
      gap: 3px;
      flex-shrink: 0;
    }
    .file-action-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--vscode-foreground);
      opacity: 0.7;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.12s ease;
    }
    .file-action-btn:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.16));
      border-color: var(--vscode-panel-border, rgba(128,128,128,0.25));
    }
    .file-action-btn-staged {
      color: var(--vscode-gitDecoration-untrackedResourceForeground, #2e8b57);
      opacity: 0.95;
    }
    .file-action-btn-staged:hover {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #d13438);
      background: rgba(209, 52, 56, 0.15);
      border-color: rgba(209, 52, 56, 0.3);
    }
    .file-action-btn-stage:hover {
      color: var(--vscode-gitDecoration-untrackedResourceForeground, #2e8b57);
      background: rgba(46, 139, 87, 0.15);
      border-color: rgba(46, 139, 87, 0.3);
    }
    .file-action-btn-discard:hover {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #d13438);
      background: rgba(209, 52, 56, 0.15);
      border-color: rgba(209, 52, 56, 0.3);
    }
    .status-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 0 4px;
      border-radius: 2px;
      flex-shrink: 0;
      cursor: pointer;
    }
    .status-badge:hover {
      opacity: 0.8;
      text-decoration: underline;
    }
    .status-m { color: var(--vscode-gitDecoration-modifiedResourceForeground, #b07d2b); }
    .status-u, .status-a { color: var(--vscode-gitDecoration-untrackedResourceForeground, #2e8b57); }
    .status-d { color: var(--vscode-gitDecoration-deletedResourceForeground, #d13438); }
    .status-r { color: var(--vscode-gitDecoration-untrackedResourceForeground, #2e8b57); }
    .empty-changes {
      font-size: 11px;
      opacity: 0.65;
      font-style: italic;
      padding: 8px 10px;
    }

    .status-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      opacity: 0.85;
      padding-top: 7px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      flex-wrap: wrap;
      gap: 4px;
    }
    .status-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .clickable {
      cursor: pointer;
    }
    .clickable:hover {
      color: var(--vscode-textLink-foreground);
    }
    .outgoing-pill-text {
      display: none;
      color: var(--vscode-textLink-foreground);
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="header-bar">
    <div class="brand-group">
      ${iconUri ? `<img src="${iconUri}" class="brand-icon" id="brandIcon" alt="Logo" title="Smart Commit Generator AI — Click for Quick Menu" />` : ""}
      <div class="pill" id="providerPill" title="Click to switch AI engine">
        <span>AI:</span> <strong id="providerText">Gemini (Free)</strong> &#9662;
      </div>
    </div>
    <div class="pill pill-safe" id="modePill" title="Click to toggle Safe / Fast Mode">
      <span class="pill-icon" id="modeIcon">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0c-.3 0-.6.1-.8.3L1.7 3.5C1.3 3.8 1 4.3 1 4.8v4.5c0 4.2 3.1 6.5 6.6 6.7h.8c3.5-.2 6.6-2.5 6.6-6.7V4.8c0-.5-.3-1-.7-1.3L8.8.3C8.6.1 8.3 0 8 0zm0 1.5l5 2.5v5.3c0 3.2-2.3 5-5 5.2-2.7-.2-5-2-5-5.2V4l5-2.5z"/></svg>
      </span>
      <span id="modeText">Safe Mode</span>
    </div>
  </div>

  <div class="commit-box-container">
    <textarea class="commit-textarea" id="commitText" placeholder="Click 'Generate Commit Message' below, or type your message here..."></textarea>
    <div class="commit-box-footer">
      <span id="charCount">0 characters</span>
      <span class="clear-link" id="btnClear">Clear</span>
    </div>
  </div>

  <button class="hero-btn" id="btnGenerate">
    <div class="btn-main">
      <svg class="btn-svg" viewBox="0 0 16 16" width="17" height="17" fill="currentColor">
        <path d="M8 0.5l2 4.5 4.5 2-4.5 2-2 4.5-2-4.5-4.5-2 4.5-2 2-4.5zM13.5 10.5l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2z"/>
      </svg>
      <span>Generate Commit Message</span>
    </div>
    <span class="hero-btn-sub">Inspects staged diff &bull; Conventional Commits (Ctrl+Alt+G)</span>
  </button>

  <div class="btn-row">
    <button class="hero-btn btn-commit-push" id="btnCommitAndPush" title="Stages, commits and pushes to remote">
      <div class="btn-main">
        <svg class="btn-svg" viewBox="0 0 16 16" width="17" height="17" fill="currentColor">
          <path d="M8 1l4 4.2h-2.8V10H6.8V5.2H4L8 1zM2 11h12c1.1 0 2 .9 2 2s-.9 2-2 2H2c-1.1 0-2-.9-2-2s.9-2 2-2z"/>
        </svg>
        <span>Commit & Push</span>
      </div>
      <span class="hero-btn-sub">1-Click Push (Ctrl+Alt+P)</span>
    </button>
    <button class="hero-btn btn-commit-only" id="btnCommitOnly" title="Commits locally without pushing">
      <div class="btn-main">
        <svg class="btn-svg" viewBox="0 0 16 16" width="17" height="17" fill="currentColor">
          <path d="M8 2.5a5.5 5.5 0 0 0-5.3 4H0.5v2.5h2.2a5.5 5.5 0 0 0 10.6 0h2.2V6.5h-2.2a5.5 5.5 0 0 0-5.3-4zm-1 7.2l-2.6-2.6 1.4-1.4 1.2 1.2 3.4-3.4 1.4 1.4-4.8 4.8z"/>
        </svg>
        <span>Commit Only</span>
      </div>
      <span class="hero-btn-sub">Local commit</span>
    </button>
  </div>

  <div class="grid">
    <div class="grid-btn" id="btnSync">
      <div class="btn-main">
        <svg class="btn-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="4" cy="3.5" r="1.8"/>
          <circle cx="4" cy="12.5" r="1.8"/>
          <circle cx="12" cy="7.5" r="1.8"/>
          <path d="M4 5.3v5.4"/>
          <path d="M4 9.5c2.5 0 5-.8 6.2-2"/>
        </svg>
        <span>Safe Sync to Branch</span>
      </div>
      <span style="font-size:9px; opacity:0.75; margin-top:2px;">(Ctrl+Alt+S)</span>
    </div>
    <div class="grid-btn" id="btnPR">
      <div class="btn-main">
        <svg class="btn-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="4" cy="3.5" r="1.8"/>
          <circle cx="4" cy="12.5" r="1.8"/>
          <circle cx="12" cy="12.5" r="1.8"/>
          <path d="M4 5.3v5.4"/>
          <path d="M12 10.7V7c0-1.7-1.3-3-3-3H6.8"/>
          <path d="M8.2 2.5L6.5 4l1.7 1.5"/>
        </svg>
        <span>Draft PR Description</span>
      </div>
      <span style="font-size:9px; opacity:0.75; margin-top:2px;">Clipboard</span>
    </div>
    <div class="grid-btn grid-btn-full" id="btnCompare">
      <div class="btn-main">
        <svg class="btn-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="2.5" width="5" height="11" rx="1.5"/>
          <rect x="9" y="2.5" width="5" height="11" rx="1.5"/>
          <line x1="4" y1="5.5" x2="5" y2="5.5"/>
          <line x1="11" y1="5.5" x2="12" y2="5.5"/>
        </svg>
        <span>Compare Branches & Conflict Advisor (Ctrl+Alt+C)</span>
      </div>
    </div>
  </div>

  <!-- Outgoing Commits Section (Waiting to Push) -->
  <div class="outgoing-container" id="outgoingContainer">
    <div class="outgoing-header" id="outgoingToggle" title="Click to toggle outgoing commits list">
      <div class="outgoing-header-left">
        <span class="chevron" id="outgoingChevron">&#9662;</span>
        <span class="outgoing-title">OUTGOING COMMITS</span>
        <span class="outgoing-count-badge" id="outgoingCountBadge">0</span>
      </div>
      <div class="outgoing-actions">
        <button class="outgoing-push-btn" id="btnPushOutgoing" title="Push pending commits to remote" style="display:none;">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1l4 4.2h-2.8V10H6.8V5.2H4L8 1zM2 11h12c1.1 0 2 .9 2 2s-.9 2-2 2H2c-1.1 0-2-.9-2-2s.9-2 2-2z"/>
          </svg>
          <span id="btnPushOutgoingText">Push</span>
        </button>
        <span class="changes-action-btn" id="btnRefreshOutgoing" title="Refresh outgoing commits">&#8635;</span>
      </div>
    </div>
    <div class="outgoing-list" id="outgoingList">
      <div class="empty-outgoing">✓ All commits pushed to remote</div>
    </div>
  </div>

  <!-- Changed Files List -->
  <div class="changes-container" id="changesContainer">
    <div class="changes-header" id="changesToggle" title="Click to toggle changed files list">
      <div class="changes-header-left">
        <span class="chevron" id="changesChevron">&#9662;</span>
        <span class="changes-title">CHANGES</span>
        <span class="changes-count-badge" id="changesCountBadge">0</span>
      </div>
      <div class="changes-actions">
        <span class="changes-action-btn changes-action-btn-success" id="btnStageAll" title="Stage All Changes (Accept All)">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/></svg>
        </span>
        <span class="changes-action-btn changes-action-btn-danger" id="btnDiscardAll" title="Discard All Changes...">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 3.5a.75.75 0 0 0-1.28-.53l-3 3a.75.75 0 0 0 0 1.06l3 3a.75.75 0 0 0 1.28-.53V7.75h4.75a4.5 4.5 0 0 1 4.5 4.5v.75a.75.75 0 0 0 1.5 0v-.75a6 6 0 0 0-6-6H4.5V3.5z"/></svg>
        </span>
        <span class="changes-action-btn" id="btnRefreshFiles" title="Refresh changed files">&#8635;</span>
      </div>
    </div>
    <div class="files-list" id="filesList">
      <div class="empty-changes">No uncommitted changes</div>
    </div>
  </div>

  <div class="status-bar">
    <div class="status-item clickable" id="repoInfo" title="Click to switch active repository">
      <span>Repo:</span> <strong id="repoName">...</strong>
    </div>
    <div class="status-item clickable" id="branchInfo" title="Click to switch or checkout branch">
      <span>Branch:</span> <strong id="branchName">main</strong>
    </div>
    <div class="status-item clickable" id="outgoingInfo" title="Commits waiting to be pushed (Click to push to remote)">
      <span id="outgoingText" class="outgoing-pill-text">↑ 0 to push</span>
    </div>
    <div class="status-item" id="stagingInfo" title="Staged and unstaged changes">
      <span id="stagedText">0 staged</span> &bull; <span id="unstagedText">0 modified</span>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const textarea = document.getElementById('commitText');
    const charCount = document.getElementById('charCount');

    function updateChars() {
      const len = textarea.value.length;
      charCount.textContent = len + ' character' + (len === 1 ? '' : 's');
    }

    textarea.addEventListener('input', () => {
      updateChars();
      vscode.postMessage({ command: 'updateCommitText', text: textarea.value });
    });

    document.getElementById('btnClear').addEventListener('click', () => {
      textarea.value = '';
      updateChars();
      vscode.postMessage({ command: 'updateCommitText', text: '' });
    });

    document.getElementById('btnGenerate').addEventListener('click', () => {
      vscode.postMessage({ command: 'generate' });
    });
    document.getElementById('btnCommitAndPush').addEventListener('click', () => {
      vscode.postMessage({ command: 'commitAndPush', text: textarea.value });
    });
    document.getElementById('btnCommitOnly').addEventListener('click', () => {
      vscode.postMessage({ command: 'commitOnly', text: textarea.value });
    });
    document.getElementById('btnSync').addEventListener('click', () => {
      vscode.postMessage({ command: 'syncBranch' });
    });
    document.getElementById('btnPR').addEventListener('click', () => {
      vscode.postMessage({ command: 'generatePR' });
    });
    document.getElementById('btnCompare').addEventListener('click', () => {
      vscode.postMessage({ command: 'compare' });
    });
    const brandIcon = document.getElementById('brandIcon');
    if (brandIcon) {
      brandIcon.addEventListener('click', () => {
        vscode.postMessage({ command: 'quickMenu' });
      });
    }
    document.getElementById('providerPill').addEventListener('click', () => {
      vscode.postMessage({ command: 'selectProvider' });
    });
    document.getElementById('modePill').addEventListener('click', () => {
      vscode.postMessage({ command: 'toggleFastMode' });
    });
    document.getElementById('repoInfo').addEventListener('click', () => {
      vscode.postMessage({ command: 'selectRepo' });
    });
    document.getElementById('branchInfo').addEventListener('click', () => {
      vscode.postMessage({ command: 'switchBranch' });
    });

    // Outgoing Commits rendering
    let currentOutgoing = [];
    function renderOutgoing(commits) {
      currentOutgoing = commits || [];
      const list = document.getElementById('outgoingList');
      const badge = document.getElementById('outgoingCountBadge');
      const btnPush = document.getElementById('btnPushOutgoing');
      const btnPushText = document.getElementById('btnPushOutgoingText');
      const outgoingInfo = document.getElementById('outgoingInfo');
      const outgoingText = document.getElementById('outgoingText');

      badge.textContent = currentOutgoing.length;
      if (currentOutgoing.length > 0) {
        badge.classList.add('has-outgoing');
        btnPush.style.display = 'inline-flex';
        btnPushText.textContent = 'Push (' + currentOutgoing.length + ')';
        if (outgoingText && outgoingInfo) {
          outgoingText.textContent = '↑ ' + currentOutgoing.length + ' to push';
          outgoingText.style.display = 'inline';
        }
      } else {
        badge.classList.remove('has-outgoing');
        btnPush.style.display = 'none';
        if (outgoingText && outgoingInfo) {
          outgoingText.style.display = 'none';
        }
      }

      if (!currentOutgoing || currentOutgoing.length === 0) {
        list.innerHTML = '<div class="empty-outgoing">✓ All commits pushed to remote</div>';
        return;
      }

      list.innerHTML = '';
      currentOutgoing.forEach((commit, idx) => {
        const item = document.createElement('div');
        item.className = 'commit-item';

        const left = document.createElement('div');
        left.className = 'commit-item-left';

        const hashSpan = document.createElement('span');
        hashSpan.className = 'commit-hash';
        hashSpan.textContent = commit.shortHash || (commit.hash ? commit.hash.substring(0, 7) : 'commit');
        hashSpan.title = 'Commit ' + (commit.hash || '') + ' (Click to copy)';
        hashSpan.style.cursor = 'pointer';
        hashSpan.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'copyText', text: commit.hash || commit.shortHash || '' });
        });

        const subjectSpan = document.createElement('span');
        subjectSpan.className = 'commit-subject';
        subjectSpan.textContent = commit.subject || '(no commit message)';
        subjectSpan.title = commit.fullMsg || commit.subject || '';

        const timeSpan = document.createElement('span');
        timeSpan.className = 'commit-time';
        timeSpan.textContent = commit.time || '';

        left.appendChild(hashSpan);
        left.appendChild(subjectSpan);
        if (commit.time) {
          left.appendChild(timeSpan);
        }

        const actions = document.createElement('div');
        actions.className = 'commit-actions';

        if (idx === 0) {
          const btnUndo = document.createElement('button');
          btnUndo.className = 'commit-action-btn-undo';
          btnUndo.title = 'Undo this commit (soft reset) — moves files back to staged & restores message in editor to edit or regenerate with AI';
          btnUndo.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 3.5a.75.75 0 0 0-1.28-.53l-3 3a.75.75 0 0 0 0 1.06l3 3a.75.75 0 0 0 1.28-.53V7.75h4.75a4.5 4.5 0 0 1 4.5 4.5v.75a.75.75 0 0 0 1.5 0v-.75a6 6 0 0 0-6-6H4.5V3.5z"/></svg><span>Undo</span>';
          btnUndo.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'undoCommit' });
          });
          actions.appendChild(btnUndo);
        }

        const btnCopy = document.createElement('button');
        btnCopy.className = 'file-action-btn';
        btnCopy.title = 'Copy commit message';
        btnCopy.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5A1.75 1.75 0 0 1 5 6.75v1.5A1.75 1.75 0 0 1 3.25 10h-1.5A1.75 1.75 0 0 1 0 8.25v-1.5zm11 0c0-.966.784-1.75 1.75-1.75h1.5A1.75 1.75 0 0 1 16 6.75v1.5A1.75 1.75 0 0 1 14.25 10h-1.5A1.75 1.75 0 0 1 11 8.25v-1.5z"/><path d="M5 2.75C5 1.784 5.784 1 6.75 1h2.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 9.25 15h-2.5A1.75 1.75 0 0 1 5 13.25V2.75z"/></svg>';
        btnCopy.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'copyText', text: commit.fullMsg || commit.subject || '' });
        });
        actions.appendChild(btnCopy);

        item.appendChild(left);
        item.appendChild(actions);
        list.appendChild(item);
      });
    }

    const outgoingToggle = document.getElementById('outgoingToggle');
    const outgoingList = document.getElementById('outgoingList');
    const outgoingChevron = document.getElementById('outgoingChevron');
    if (outgoingToggle) {
      outgoingToggle.addEventListener('click', (e) => {
        if (e.target.id === 'btnPushOutgoing' || e.target.closest('#btnPushOutgoing') || e.target.id === 'btnRefreshOutgoing') return;
        outgoingList.classList.toggle('collapsed');
        outgoingChevron.classList.toggle('collapsed');
      });
    }

    const btnPushOutgoing = document.getElementById('btnPushOutgoing');
    if (btnPushOutgoing) {
      btnPushOutgoing.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'pushCommits' });
      });
    }

    const btnRefreshOutgoing = document.getElementById('btnRefreshOutgoing');
    if (btnRefreshOutgoing) {
      btnRefreshOutgoing.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'refresh' });
      });
    }

    const outgoingInfo = document.getElementById('outgoingInfo');
    if (outgoingInfo) {
      outgoingInfo.addEventListener('click', () => {
        vscode.postMessage({ command: 'pushCommits' });
      });
    }

    // Files List rendering
    let currentFiles = [];
    function renderFiles(files) {
      currentFiles = files || [];
      const list = document.getElementById('filesList');
      const badge = document.getElementById('changesCountBadge');
      badge.textContent = currentFiles.length;
      if (currentFiles.length === 0) {
        badge.style.background = 'var(--vscode-badge-background)';
        badge.style.color = 'var(--vscode-badge-foreground)';
      } else {
        badge.style.background = 'var(--vscode-button-background)';
        badge.style.color = 'var(--vscode-button-foreground)';
      }

      if (!currentFiles || currentFiles.length === 0) {
        list.innerHTML = '<div class="empty-changes">No uncommitted changes</div>';
        return;
      }

      list.innerHTML = '';
      currentFiles.forEach(file => {
        const item = document.createElement('div');
        item.className = 'file-item';

        const info = document.createElement('div');
        info.className = 'file-info';
        info.title = 'Click to open ' + file.fileName + ' in editor';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-name';
        nameSpan.textContent = file.fileName;

        const pathSpan = document.createElement('span');
        pathSpan.className = 'file-path';
        pathSpan.textContent = file.dirName;

        info.appendChild(nameSpan);
        if (file.dirName) {
          info.appendChild(pathSpan);
        }

        // Clicking file name/path opens the file directly in editor!
        info.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({
            command: 'openFile',
            relPath: file.relPath
          });
        });

        // Action buttons container
        const actions = document.createElement('div');
        actions.className = 'file-actions';

        // 1. Stage / Accept button (or Unstage if already staged)
        const btnStage = document.createElement('button');
        if (file.isStaged) {
          btnStage.className = 'file-action-btn file-action-btn-staged';
          btnStage.title = 'Unstage changes in ' + file.fileName;
          btnStage.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>';
          btnStage.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({
              command: 'unstageFile',
              relPath: file.relPath
            });
          });
        } else {
          btnStage.className = 'file-action-btn file-action-btn-stage';
          btnStage.title = 'Stage / Accept changes in ' + file.fileName;
          btnStage.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/></svg>';
          btnStage.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({
              command: 'stageFile',
              relPath: file.relPath
            });
          });
        }

        // 2. Discard button
        const btnDiscard = document.createElement('button');
        btnDiscard.className = 'file-action-btn file-action-btn-discard';
        btnDiscard.title = 'Discard changes in ' + file.fileName + '...';
        btnDiscard.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 3.5a.75.75 0 0 0-1.28-.53l-3 3a.75.75 0 0 0 0 1.06l3 3a.75.75 0 0 0 1.28-.53V7.75h4.75a4.5 4.5 0 0 1 4.5 4.5v.75a.75.75 0 0 0 1.5 0v-.75a6 6 0 0 0-6-6H4.5V3.5z"/></svg>';
        btnDiscard.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({
            command: 'discardFile',
            relPath: file.relPath,
            status: file.status
          });
        });

        // 3. "Open File" button (file editor icon)
        const btnOpenFile = document.createElement('button');
        btnOpenFile.className = 'file-action-btn';
        btnOpenFile.title = 'Open ' + file.fileName + ' in editor';
        btnOpenFile.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1h6l4 4v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm5 1H4v12h9V6H9V2zm1 0v3h3l-3-3z"/></svg>';
        btnOpenFile.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({
            command: 'openFile',
            relPath: file.relPath
          });
        });

        // 2. "Open Diff" button (diff split icon)
        const btnOpenDiff = document.createElement('button');
        btnOpenDiff.className = 'file-action-btn';
        btnOpenDiff.title = 'View diff against HEAD';
        btnOpenDiff.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2h3v12H4V2zm5 0h3v12H9V2zM1 4h1v8H1V4zm13 0h1v8h-1V4z"/></svg>';
        btnOpenDiff.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({
            command: 'openDiff',
            relPath: file.relPath,
            status: file.status
          });
        });

        // 3. Status badge (M, U, A, D) - clicking it opens diff
        const badgeSpan = document.createElement('span');
        badgeSpan.className = 'status-badge status-' + (file.status || 'm').toLowerCase();
        badgeSpan.textContent = file.status;
        badgeSpan.title = (file.status === 'M' ? 'Modified' : file.status === 'U' ? 'Untracked' : file.status === 'D' ? 'Deleted' : 'Added') + ' (Click to view diff)';
        badgeSpan.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({
            command: 'openDiff',
            relPath: file.relPath,
            status: file.status
          });
        });

        actions.appendChild(btnStage);
        actions.appendChild(btnDiscard);
        actions.appendChild(btnOpenDiff);
        actions.appendChild(btnOpenFile);
        actions.appendChild(badgeSpan);

        item.appendChild(info);
        item.appendChild(actions);

        list.appendChild(item);
      });
    }

    const changesToggle = document.getElementById('changesToggle');
    const filesList = document.getElementById('filesList');
    const chevron = document.getElementById('changesChevron');
    changesToggle.addEventListener('click', (e) => {
      if (e.target.id === 'btnRefreshFiles' || e.target.closest('.changes-actions')) return;
      filesList.classList.toggle('collapsed');
      chevron.classList.toggle('collapsed');
    });

    const btnStageAll = document.getElementById('btnStageAll');
    if (btnStageAll) {
      btnStageAll.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'stageAll' });
      });
    }

    const btnDiscardAll = document.getElementById('btnDiscardAll');
    if (btnDiscardAll) {
      btnDiscardAll.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'discardAll' });
      });
    }

    document.getElementById('btnRefreshFiles').addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ command: 'refresh' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'update') {
        document.getElementById('providerText').textContent = msg.provider || 'AI';
        const modePill = document.getElementById('modePill');
        const modeIcon = document.getElementById('modeIcon');
        const modeText = document.getElementById('modeText');
        const SHIELD_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0c-.3 0-.6.1-.8.3L1.7 3.5C1.3 3.8 1 4.3 1 4.8v4.5c0 4.2 3.1 6.5 6.6 6.7h.8c3.5-.2 6.6-2.5 6.6-6.7V4.8c0-.5-.3-1-.7-1.3L8.8.3C8.6.1 8.3 0 8 0zm0 1.5l5 2.5v5.3c0 3.2-2.3 5-5 5.2-2.7-.2-5-2-5-5.2V4l5-2.5z"/></svg>';
        const ZAP_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8.5 0L1 9h5v7l7.5-9H8.5V0z"/></svg>';
        if (msg.isFast) {
          modePill.className = 'pill pill-fast';
          if (modeIcon) modeIcon.innerHTML = ZAP_ICON;
          modeText.textContent = 'Fast Mode';
        } else {
          modePill.className = 'pill pill-safe';
          if (modeIcon) modeIcon.innerHTML = SHIELD_ICON;
          modeText.textContent = 'Safe Mode';
        }
        if (msg.repoName) {
          document.getElementById('repoName').textContent = msg.repoName + (msg.repoCount > 1 ? ' ▾' : '');
        }
        document.getElementById('branchName').textContent = (msg.branch || 'main') + ' ▾';
        document.getElementById('stagedText').textContent = msg.stagedCount + ' staged';
        document.getElementById('unstagedText').textContent = msg.unstagedCount + ' modified';

        if (msg.commitText !== undefined && msg.commitText !== textarea.value && document.activeElement !== textarea) {
          textarea.value = msg.commitText;
          updateChars();
        }

        if (msg.files !== undefined) {
          renderFiles(msg.files);
        }

        if (msg.outgoingCommits !== undefined) {
          renderOutgoing(msg.outgoingCommits);
        }
      }
    });

    vscode.postMessage({ command: 'refresh' });
  </script>
</body>
</html>`;
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
