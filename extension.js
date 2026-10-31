const vscode = require("vscode");
const { execFile } = require("child_process");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

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

function getSetting(key) {
  const config = vscode.workspace.getConfiguration("smartCommit");
  let val = config.get(key);
  if (val !== undefined && val !== null && val !== "") return val;

  const globalConfig = vscode.workspace.getConfiguration();
  val = globalConfig.get(`smartCommit.${key}`);
  if (val !== undefined && val !== null && val !== "") return val;

  // Fail-safe direct read from local settings.json
  try {
    const candidates = [
      path.join(
        process.env.APPDATA || "",
        "Antigravity IDE",
        "User",
        "settings.json",
      ),
      path.join(
        process.env.APPDATA || "",
        "Antigravity",
        "User",
        "settings.json",
      ),
      path.join(process.env.APPDATA || "", "Code", "User", "settings.json"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, "utf8");
        const reg = new RegExp(
          `"smartCommit\\.${key}"\\s*:\\s*(true|false|"[^"]+"|[0-9]+)`,
        );
        const m = raw.match(reg);
        if (m && m[1]) {
          let parsed = m[1];
          if (parsed === "true") return true;
          if (parsed === "false") return false;
          if (parsed.startsWith('"') && parsed.endsWith('"'))
            return parsed.slice(1, -1);
          return parsed;
        }
      }
    }
  } catch (e) {}

  return "";
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

let currentTargetRepoUri = null;

function getTargetRepository(arg) {
  const gitExtension = vscode.extensions.getExtension("vscode.git");
  if (!gitExtension) return null;
  const api = gitExtension.exports.getAPI(1);
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

function requestOpenAICompatible({
  baseUrl,
  apiKey,
  model,
  userContent,
  systemPrompt = SYSTEM_PROMPT,
  maxTokens = 600,
  providerName = "AI",
}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(baseUrl);
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
          const text = json.choices?.[0]?.message?.content?.trim();
          resolve(cleanCommitMessage(text));
        } catch (e) {
          reject(e);
        }
      });
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

async function executeAiCompletion(
  provider,
  apiKey,
  modelOverride,
  userContent,
  systemPrompt = SYSTEM_PROMPT,
  maxTokens = 600,
) {
  if (provider === "gemini") {
    return await requestGemini(
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
      model: modelOverride || "grok-2-latest",
      userContent,
      systemPrompt,
      maxTokens,
      providerName: "Grok",
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
  return await requestOpenAI(
    apiKey,
    modelOverride,
    userContent,
    systemPrompt,
    maxTokens,
  );
}

function requestGemini(
  apiKey,
  model,
  userContent,
  systemPrompt = SYSTEM_PROMPT,
  maxTokens = 600,
) {
  return new Promise((resolve, reject) => {
    const modelName = model || "gemini-3.8-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const payload = JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: maxTokens,
      },
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
            return reject(
              new Error(`Gemini API error (${res.statusCode}): ${body}`),
            );
          }
          try {
            const json = JSON.parse(body);
            const text =
              json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            resolve(cleanCommitMessage(text));
          } catch (e) {
            reject(e);
          }
        });
      },
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function resolveApiKey(provider) {
  if (provider === "ollama") {
    return "local-ollama";
  }

  const openaiKey = getSetting("openaiApiKey");
  const geminiKey = getSetting("geminiApiKey");
  const deepseekKey = getSetting("deepseekApiKey");
  const groqKey = getSetting("groqApiKey");
  const grokKey = getSetting("grokApiKey");

  let apiKey = "";
  let providerLabel = "OpenAI";
  let targetSetting = "openaiApiKey";

  if (provider === "gemini") {
    apiKey = geminiKey;
    providerLabel = "Google Gemini";
    targetSetting = "geminiApiKey";
  } else if (provider === "deepseek") {
    apiKey = deepseekKey;
    providerLabel = "DeepSeek";
    targetSetting = "deepseekApiKey";
  } else if (provider === "groq") {
    apiKey = groqKey;
    providerLabel = "Groq";
    targetSetting = "groqApiKey";
  } else if (provider === "grok") {
    apiKey = grokKey;
    providerLabel = "Grok (xAI)";
    targetSetting = "grokApiKey";
  } else {
    apiKey = openaiKey;
    providerLabel = "OpenAI";
    targetSetting = "openaiApiKey";
  }

  if (!apiKey) {
    const providerKeyUrls = {
      gemini: "https://aistudio.google.com/app/apikey",
      groq: "https://console.groq.com/keys",
      deepseek: "https://platform.deepseek.com/api_keys",
      grok: "https://console.x.ai",
      openai: "https://platform.openai.com/api-keys",
    };

    const isFreeTier = provider === "gemini" || provider === "groq";
    const getKeyAction = isFreeTier ? "Get Free API Key" : "Get API Key";

    const choice = await vscode.window.showWarningMessage(
      `Smart Commit: No API key configured for "${providerLabel}".`,
      "Enter API Key",
      getKeyAction,
      "Open Settings",
    );

    if (choice === getKeyAction) {
      const url = providerKeyUrls[provider] || "https://google.com";
      await vscode.env.openExternal(vscode.Uri.parse(url));
      const entered = await vscode.window.showInputBox({
        prompt: `Paste your ${providerLabel} API Key here`,
        password: true,
        ignoreFocusOut: true,
      });
      if (entered && entered.trim()) {
        apiKey = entered.trim();
        await vscode.workspace
          .getConfiguration("smartCommit")
          .update(targetSetting, apiKey, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          `Smart Commit: ${providerLabel} API Key saved successfully!`,
        );
        return apiKey;
      }
      return null;
    }

    if (choice === "Enter API Key") {
      const entered = await vscode.window.showInputBox({
        prompt: `Paste your ${providerLabel} API Key`,
        password: true,
        ignoreFocusOut: true,
      });

      if (entered && entered.trim()) {
        apiKey = entered.trim();
        await vscode.workspace
          .getConfiguration("smartCommit")
          .update(targetSetting, apiKey, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          `Smart Commit: ${providerLabel} API Key saved successfully!`,
        );
      } else {
        return null;
      }
    } else if (choice === "Open Settings") {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "smartCommit",
      );
      return null;
    } else {
      return null;
    }
  }

  return apiKey;
}

async function buildDiffContent(cwd, autoStage = false) {
  let stagedDiff = await runGit(["diff", "--cached"], cwd);
  let statSummary = "";

  if (!stagedDiff.trim() && autoStage) {
    await runGit(["add", "-A"], cwd);
    stagedDiff = await runGit(["diff", "--cached"], cwd);
  }

  if (stagedDiff.trim()) {
    statSummary = await runGit(["diff", "--cached", "--stat"], cwd);
    return `STAGED CHANGES SUMMARY:\n${statSummary}\n\nSTAGED DIFF:\n${stagedDiff}`;
  }

  const unstagedDiff = await runGit(["diff"], cwd);
  if (unstagedDiff.trim()) {
    statSummary = await runGit(["diff", "--stat"], cwd);
    return `UNSTAGED CHANGES SUMMARY:\n${statSummary}\n\nUNSTAGED DIFF:\n${unstagedDiff}`;
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
  const provider = getSetting("provider") || "openai";
  const modelOverride = getSetting("model");
  const apiKey = await resolveApiKey(provider);
  if (!apiKey) return null;

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
    provider,
    apiKey,
    modelOverride,
    userPrompt,
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
    try {
      const userHome = process.env.USERPROFILE || process.env.HOME || "";
      const localTargets = [
        path.join(
          userHome,
          ".antigravity-ide",
          "extensions",
          "smart-commit-generator",
          "package.json",
        ),
        path.join(
          userHome,
          ".antigravity",
          "extensions",
          "smart-commit-generator",
          "package.json",
        ),
        path.join(
          userHome,
          ".vscode",
          "extensions",
          "smart-commit-generator",
          "package.json",
        ),
      ];
      for (const target of localTargets) {
        if (fs.existsSync(path.dirname(target))) {
          fs.writeFileSync(target, jsonStr, "utf8");
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

  // Auto-sync context and status bar when configuration changes
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
            label: "$(gear) Extension Settings",
            description: "Configure OpenAI / Gemini API keys and defaults",
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
              diffBody = await runGit(["diff", `${targetBranch}...HEAD`], cwd);
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
      const provider = getSetting("provider") || "openai";
      const modelOverride = getSetting("model");
      const apiKey = await resolveApiKey(provider);
      if (!apiKey) return;

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
              diffBody = await runGit(["diff", `${baseBranch}...HEAD`], cwd);
            } catch (e) {
              diffBody = await runGit(["diff"], cwd).catch(() => "");
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
              PR_SYSTEM_PROMPT,
              1000,
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
      const provider = getSetting("provider") || "openai";
      const modelOverride = getSetting("model");
      const apiKey = await resolveApiKey(provider);
      if (!apiKey) return;

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
              diffBody = await runGit(
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
      const currentProvider = getSetting("provider") || "openai";
      const items = [
        {
          label: "$(sparkle) Google Gemini",
          description: "100% Free tier (1,500 req/day)",
          value: "gemini",
        },
        {
          label: "$(zap) Groq",
          description: "100% Free tier (Sub-second LPU inference)",
          value: "groq",
        },
        {
          label: "$(server) Ollama",
          description: "100% Free & Offline (Local, zero API key)",
          value: "ollama",
        },
        {
          label: "$(circuit-board) DeepSeek",
          description: "Ultra-low cost ($0.14 / 1M tokens)",
          value: "deepseek",
        },
        {
          label: "$(rocket) Grok (xAI)",
          description: "Latest Grok-2 by xAI",
          value: "grok",
        },
        {
          label: "$(hubot) OpenAI",
          description: "Standard GPT-4o-mini / GPT-4o",
          value: "openai",
        },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        title: "Smart Git: Select Active AI Provider",
        placeHolder: `Current provider: ${currentProvider}`,
      });

      if (selected) {
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
        if (actionsViewProvider) {
          actionsViewProvider.updateState();
        }
      }
    },
  );

  // 10. Webview Providers for Activity Bar & Source Control View
  const actionsViewProvider = new SmartGitViewProvider(context.extensionUri);
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
    actionsViewProvider.updateState(extra);
    actionsViewScmProvider.updateState(extra);
  }

  // 11. Command: Select Active Repository
  const disposableSelectRepo = vscode.commands.registerCommand(
    "smartCommit.selectRepository",
    async () => {
      const gitExtension = vscode.extensions.getExtension("vscode.git");
      if (!gitExtension) return;
      const api = gitExtension.exports.getAPI(1);
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
        const commitMsg = (customMsg || (repo.inputBox && repo.inputBox.value) || "").trim();
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

  // 14. Command: Switch / Checkout Branch
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

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("smartCommit")) {
      notifyAllViews();
      updateStatusBarMode(getSetting("confirmBeforePush") === false);
    }
  });

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
    disposableSelectRepo,
    disposableCommitOnly,
    disposableSwitchBranch,
    viewDisposable1,
    viewDisposable2,
  );
}

class SmartGitViewProvider {
  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = null;
  }

  resolveWebviewView(webviewView, context, _token) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    const iconUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "icon.png"),
    );

    webviewView.webview.html = this._getHtmlForWebview(iconUri);

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
        case "selectRepo":
          vscode.commands.executeCommand("smartCommit.selectRepository");
          break;
        case "switchBranch":
          vscode.commands.executeCommand("smartCommit.switchBranch");
          break;
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
    const provider = getSetting("provider") || "openai";
    const isFast = getSetting("confirmBeforePush") === false;

    let branch = "HEAD";
    let stagedCount = 0;
    let unstagedCount = 0;
    let commitText = extra.commitText !== undefined ? extra.commitText : "";
    let repoName = "";
    let repoCount = 1;
    const files = [];

    try {
      const gitExtension = vscode.extensions.getExtension("vscode.git");
      if (gitExtension) {
        const api = gitExtension.exports.getAPI(1);
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
      groq: "Groq (Free)",
      ollama: "Ollama (Offline)",
      deepseek: "DeepSeek",
      grok: "Grok (xAI)",
      openai: "OpenAI",
    };

    this._view.webview.postMessage({
      type: "update",
      provider: providerLabels[provider] || provider,
      isFast,
      repoName,
      repoCount,
      branch,
      stagedCount,
      unstagedCount,
      commitText,
      files,
    });
  }

  _getHtmlForWebview(iconUri = "") {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
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
      box-shadow: 0 1px 3px rgba(0,0,0,0.25);
      transition: transform 0.15s ease;
      flex-shrink: 0;
    }
    .brand-icon:hover {
      transform: scale(1.08);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 12px;
      background: var(--vscode-badge-background, #333);
      color: var(--vscode-badge-foreground, #fff);
      cursor: pointer;
      border: 1px solid var(--vscode-widget-border, transparent);
      transition: opacity 0.15s ease, transform 0.1s ease;
      white-space: nowrap;
    }
    .pill:hover {
      opacity: 0.85;
      transform: translateY(-1px);
    }
    .pill-fast {
      background: #e67e22;
      color: #fff;
    }
    .pill-safe {
      background: #2980b9;
      color: #fff;
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
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 4px;
      resize: vertical;
      outline: none;
      user-select: text;
    }
    .commit-textarea:focus {
      border-color: var(--vscode-focusBorder, #007acc);
    }
    .commit-box-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      opacity: 0.7;
      margin-top: 3px;
      padding: 0 2px;
    }
    .clear-link {
      cursor: pointer;
      color: var(--vscode-textLink-foreground, #3794ff);
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
      border: none;
      cursor: pointer;
      margin-bottom: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 600;
      font-size: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
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
      background: #16a085;
      color: #fff;
    }
    .btn-commit-push:hover {
      background: #1abc9c;
    }
    .btn-commit-only {
      background: var(--vscode-button-secondaryBackground, #2d3748);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    .btn-commit-only:hover {
      background: var(--vscode-button-secondaryHoverBackground, #4a5568);
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
      border: 1px solid var(--vscode-widget-border, #444);
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      transition: all 0.15s;
    }
    .grid-btn:hover {
      background: var(--vscode-list-hoverBackground, #333);
      border-color: var(--vscode-focusBorder, #007acc);
      transform: translateY(-1px);
    }
    .grid-btn-full {
      grid-column: span 2;
    }

    /* Changed Files Section */
    .changes-container {
      margin: 8px 0;
      border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.12));
      border-radius: 5px;
      background: var(--vscode-editor-background, #1e1e1e);
      overflow: hidden;
    }
    .changes-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      cursor: pointer;
      user-select: none;
      background: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,0.03));
      border-bottom: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
    }
    .changes-header:hover {
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06));
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
      background: #0078d4;
      color: #ffffff;
    }
    .changes-action-btn {
      font-size: 13px;
      opacity: 0.7;
      padding: 2px 5px;
      border-radius: 3px;
      cursor: pointer;
    }
    .changes-action-btn:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.1));
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
      background: var(--vscode-list-hoverBackground, #2a2d2e);
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
      color: var(--vscode-textLink-foreground, #3794ff);
    }
    .file-name {
      font-weight: 500;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-path {
      font-size: 10px;
      opacity: 0.5;
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
      opacity: 0.65;
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
      background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.15));
      border-color: var(--vscode-widget-border, rgba(255, 255, 255, 0.2));
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
    .status-m { color: #e2c08d; }
    .status-u, .status-a { color: #73c991; }
    .status-d { color: #f14c4c; }
    .status-r { color: #73c991; }
    .empty-changes {
      font-size: 11px;
      opacity: 0.6;
      font-style: italic;
      padding: 8px 10px;
    }

    .status-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      opacity: 0.8;
      padding-top: 7px;
      border-top: 1px solid var(--vscode-widget-border, #333);
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
      color: var(--vscode-textLink-foreground, #3794ff);
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

  <!-- Changed Files List -->
  <div class="changes-container" id="changesContainer">
    <div class="changes-header" id="changesToggle" title="Click to toggle changed files list">
      <div class="changes-header-left">
        <span class="chevron" id="changesChevron">&#9662;</span>
        <span class="changes-title">CHANGES</span>
        <span class="changes-count-badge" id="changesCountBadge">0</span>
      </div>
      <div class="changes-actions">
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
    <div class="status-item" id="stagingInfo" title="Staged and unstaged changes">
      <span id="stagedText">0 staged</span> &bull; <span id="unstagedText">0 modified</span>
    </div>
  </div>

  <script>
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

    // Files List rendering
    let currentFiles = [];
    function renderFiles(files) {
      currentFiles = files || [];
      const list = document.getElementById('filesList');
      const badge = document.getElementById('changesCountBadge');
      badge.textContent = currentFiles.length;
      if (currentFiles.length === 0) {
        badge.style.background = 'var(--vscode-badge-background, #3a3d41)';
        badge.style.color = 'var(--vscode-badge-foreground, #ffffff)';
      } else {
        badge.style.background = '#0078d4';
        badge.style.color = '#ffffff';
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

        // 1. "Open File" button (file editor icon)
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

        actions.appendChild(btnOpenFile);
        actions.appendChild(btnOpenDiff);
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

    document.getElementById('btnRefreshFiles').addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ command: 'refresh' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'update') {
        document.getElementById('providerText').textContent = msg.provider || 'AI';
        const modePill = document.getElementById('modePill');
        const modeText = document.getElementById('modeText');
        if (msg.isFast) {
          modePill.className = 'pill pill-fast';
          modeText.textContent = 'Fast Mode';
        } else {
          modePill.className = 'pill pill-safe';
          modeText.textContent = 'Safe Mode';
        }
        if (msg.repoName) {
          document.getElementById('repoName').textContent = msg.repoName + (msg.repoCount > 1 ? ' ▾' : '');
        }
        document.getElementById('branchName').textContent = (msg.branch || 'main') + ' ▾';
        document.getElementById('stagedText').textContent = msg.stagedCount + ' staged';
        document.getElementById('unstagedText').textContent = msg.unstagedCount + ' modified';

        if (msg.commitText !== undefined && msg.commitText !== textarea.value) {
          textarea.value = msg.commitText;
          updateChars();
        }

        if (msg.files !== undefined) {
          renderFiles(msg.files);
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
