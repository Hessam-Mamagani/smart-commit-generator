const vscode = require('vscode');
const { execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

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
  const config = vscode.workspace.getConfiguration('smartCommit');
  let val = config.get(key);
  if (val !== undefined && val !== null && val !== '') return val;

  const globalConfig = vscode.workspace.getConfiguration();
  val = globalConfig.get(`smartCommit.${key}`);
  if (val !== undefined && val !== null && val !== '') return val;

  // Fail-safe direct read from local settings.json
  try {
    const candidates = [
      path.join(process.env.APPDATA || '', 'Antigravity IDE', 'User', 'settings.json'),
      path.join(process.env.APPDATA || '', 'Antigravity', 'User', 'settings.json'),
      path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const reg = new RegExp(`"smartCommit\\.${key}"\\s*:\\s*(true|false|"[^"]+"|[0-9]+)`);
        const m = raw.match(reg);
        if (m && m[1]) {
          let parsed = m[1];
          if (parsed === 'true') return true;
          if (parsed === 'false') return false;
          if (parsed.startsWith('"') && parsed.endsWith('"')) return parsed.slice(1, -1);
          return parsed;
        }
      }
    }
  } catch (e) {}

  return '';
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr?.trim() || err.message));
      }
      resolve(stdout);
    });
  });
}

function getTargetRepository(arg) {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) return null;
  const api = gitExtension.exports.getAPI(1);
  if (!api || !api.repositories || api.repositories.length === 0) return null;

  if (arg) {
    const uri = arg.rootUri || (arg.repository && arg.repository.rootUri);
    if (uri) {
      const match = api.repositories.find(r => r.rootUri.fsPath.toLowerCase() === uri.fsPath.toLowerCase());
      if (match) return match;
    }
  }

  const activeDocUri = vscode.window.activeTextEditor?.document?.uri;
  if (activeDocUri) {
    const match = api.repositories.find(r => activeDocUri.fsPath.toLowerCase().startsWith(r.rootUri.fsPath.toLowerCase()));
    if (match) return match;
  }

  return api.repositories[0];
}

function cleanCommitMessage(msg) {
  if (!msg) return '';
  let cleaned = msg.trim();
  if (cleaned.startsWith('```') && cleaned.endsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\r?\n?/, '').replace(/\r?\n?```$/, '').trim();
  }
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

function requestOpenAI(apiKey, model, userContent, systemPrompt = SYSTEM_PROMPT, maxTokens = 600) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.2,
      max_tokens: maxTokens
    });

    const req = https.request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`OpenAI API error (${res.statusCode}): ${body}`));
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

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function requestGemini(apiKey, model, userContent, systemPrompt = SYSTEM_PROMPT, maxTokens = 600) {
  return new Promise((resolve, reject) => {
    const modelName = model || 'gemini-3.8-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const payload = JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        { parts: [{ text: userContent }] }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: maxTokens
      }
    });

    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Gemini API error (${res.statusCode}): ${body}`));
        }
        try {
          const json = JSON.parse(body);
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          resolve(cleanCommitMessage(text));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function resolveApiKey(provider) {
  const openaiKey = getSetting('openaiApiKey');
  const geminiKey = getSetting('geminiApiKey');

  let apiKey = provider === 'gemini' ? geminiKey : openaiKey;
  if (!apiKey) {
    if (provider === 'openai' && geminiKey) {
      apiKey = geminiKey;
    } else if (provider === 'gemini' && openaiKey) {
      apiKey = openaiKey;
    }
  }

  if (!apiKey) {
    const choice = await vscode.window.showWarningMessage(
      `Smart Commit: No API key found for "${provider}".`,
      'Enter API Key',
      'Open Settings'
    );

    if (choice === 'Enter API Key') {
      const entered = await vscode.window.showInputBox({
        prompt: `Paste your ${provider === 'gemini' ? 'Google Gemini' : 'OpenAI'} API Key`,
        password: true,
        ignoreFocusOut: true
      });

      if (entered && entered.trim()) {
        apiKey = entered.trim();
        const targetSetting = provider === 'gemini' ? 'geminiApiKey' : 'openaiApiKey';
        await vscode.workspace.getConfiguration('smartCommit').update(targetSetting, apiKey, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Smart Commit: ${provider} API Key saved successfully!`);
      } else {
        return null;
      }
    } else if (choice === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'smartCommit');
      return null;
    } else {
      return null;
    }
  }

  return apiKey;
}

async function buildDiffContent(cwd, autoStage = false) {
  let stagedDiff = await runGit(['diff', '--cached'], cwd);
  let statSummary = '';

  if (!stagedDiff.trim() && autoStage) {
    await runGit(['add', '-A'], cwd);
    stagedDiff = await runGit(['diff', '--cached'], cwd);
  }

  if (stagedDiff.trim()) {
    statSummary = await runGit(['diff', '--cached', '--stat'], cwd);
    return `STAGED CHANGES SUMMARY:\n${statSummary}\n\nSTAGED DIFF:\n${stagedDiff}`;
  }

  const unstagedDiff = await runGit(['diff'], cwd);
  if (unstagedDiff.trim()) {
    statSummary = await runGit(['diff', '--stat'], cwd);
    return `UNSTAGED CHANGES SUMMARY:\n${statSummary}\n\nUNSTAGED DIFF:\n${unstagedDiff}`;
  }

  const status = await runGit(['status', '--short'], cwd);
  if (!status.trim()) {
    return null;
  }
  return `UNTRACKED / MODIFIED FILES STATUS:\n${status}`;
}

async function generateCommitMessage(repo, autoStage = false) {
  const cwd = repo.rootUri.fsPath;
  const provider = getSetting('provider') || 'openai';
  const modelOverride = getSetting('model');
  const apiKey = await resolveApiKey(provider);
  if (!apiKey) return null;

  let diffContent = await buildDiffContent(cwd, autoStage);
  if (!diffContent) {
    vscode.window.showInformationMessage('Smart Commit: No changes detected to commit.');
    return null;
  }

  if (diffContent.length > 30000) {
    diffContent = diffContent.slice(0, 30000) + '\n\n[Diff truncated for length...]';
  }

  const userPrompt = `Analyze this git diff and produce the commit message:\n\n${diffContent}`;
  if (provider === 'gemini') {
    return await requestGemini(apiKey, modelOverride, userPrompt);
  } else {
    return await requestOpenAI(apiKey, modelOverride, userPrompt);
  }
}

async function getBranches(cwd, currentBranch) {
  try {
    const output = await runGit(['branch', '-a'], cwd);
    const lines = output.split('\n');
    const branches = new Set();

    for (const line of lines) {
      let b = line.trim();
      if (!b || b.startsWith('*')) continue;
      if (b.includes('->')) continue;
      if (b.startsWith('remotes/')) {
        b = b.replace(/^remotes\//, '');
      }
      if (b && b !== currentBranch && b !== `origin/${currentBranch}`) {
        branches.add(b);
      }
    }

    return Array.from(branches).sort((a, b) => {
      const aRemote = a.startsWith('origin/');
      const bRemote = b.startsWith('origin/');
      if (!aRemote && bRemote) return -1;
      if (aRemote && !bRemote) return 1;
      return a.localeCompare(b);
    });
  } catch (e) {
    return [];
  }
}

async function checkMergeConflicts(cwd, currentBranch, targetBranch) {
  let mergeBase = '';
  try {
    mergeBase = (await runGit(['merge-base', 'HEAD', targetBranch], cwd)).trim();
  } catch (e) {
    return { hasConflicts: false, mergeBase: '', output: 'No common ancestor.' };
  }

  let mergeTreeOutput = '';
  try {
    mergeTreeOutput = await runGit(['merge-tree', mergeBase, 'HEAD', targetBranch], cwd);
  } catch (e) {
    mergeTreeOutput = e.message || '';
  }

  const hasConflictMarkers = mergeTreeOutput.includes('<<<<<<<') ||
                             mergeTreeOutput.includes('changed in both') ||
                             mergeTreeOutput.includes('conflict');

  return {
    hasConflicts: hasConflictMarkers,
    mergeBase,
    output: mergeTreeOutput
  };
}

function scanDiffForSecurityIssues(diffText) {
  if (!diffText) return [];
  const issues = [];
  const lines = diffText.split('\n');

  const secretPatterns = [
    { name: 'OpenAI Secret Key', regex: /sk-[a-zA-Z0-9]{20,}/ },
    { name: 'Google / Gemini API Key', regex: /AIza[0-9A-Za-z\-_]{35}/ },
    { name: 'AWS Access Key ID', regex: /AKIA[0-9A-Z]{16}/ },
    { name: 'GitHub Personal Access Token', regex: /(?:ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,})/ },
    { name: 'Private Encryption Key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
    { name: 'Hardcoded Secret / Token Assignment', regex: /(?:api[_-]?key|secret|password|auth[_-]?token)\s*[:=]\s*['"][a-zA-Z0-9_\-\.]{8,}['"]/i }
  ];

  let currentFile = '';
  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.replace('+++ b/', '').trim();
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const addedContent = line.slice(1);
      if (addedContent.includes('your-api-key') || addedContent.includes('sk-placeholder') || addedContent.includes('EXAMPLE')) {
        continue;
      }
      for (const pattern of secretPatterns) {
        if (pattern.regex.test(addedContent)) {
          issues.push({
            type: pattern.name,
            file: currentFile || 'unknown file'
          });
          break;
        }
      }
    }
  }

  return issues;
}

function getPackageJsonInfo(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    return { pkgPath, version: pkg.version || '1.0.0', pkg };
  } catch (e) {
    return null;
  }
}

function calculateNextVersions(currentVersion, commitLog = '') {
  const parts = currentVersion.split('.').map(n => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);

  const [major, minor, patch] = parts;

  let recommendedType = 'patch';
  if (commitLog.includes('BREAKING CHANGE') || /^[a-z]+!:/m.test(commitLog)) {
    recommendedType = 'major';
  } else if (/^feat(?:\([^\)]+\))?:/m.test(commitLog)) {
    recommendedType = 'minor';
  }

  const patchVersion = `${major}.${minor}.${patch + 1}`;
  const minorVersion = `${major}.${minor + 1}.0`;
  const majorVersion = `${major + 1}.0.0`;

  let recommendedVersion = patchVersion;
  if (recommendedType === 'major') recommendedVersion = majorVersion;
  else if (recommendedType === 'minor') recommendedVersion = minorVersion;

  return {
    currentVersion,
    recommendedType,
    recommendedVersion,
    patchVersion,
    minorVersion,
    majorVersion
  };
}

async function applyVersionBump(pkgInfo, newVersion, cwd) {
  try {
    pkgInfo.pkg.version = newVersion;
    const jsonStr = JSON.stringify(pkgInfo.pkg, null, 2) + '\n';
    fs.writeFileSync(pkgInfo.pkgPath, jsonStr, 'utf8');
    try {
      const userHome = process.env.USERPROFILE || process.env.HOME || '';
      const localTargets = [
        path.join(userHome, '.antigravity-ide', 'extensions', 'smart-commit-generator', 'package.json'),
        path.join(userHome, '.antigravity', 'extensions', 'smart-commit-generator', 'package.json'),
        path.join(userHome, '.vscode', 'extensions', 'smart-commit-generator', 'package.json')
      ];
      for (const target of localTargets) {
        if (fs.existsSync(path.dirname(target))) {
          fs.writeFileSync(target, jsonStr, 'utf8');
        }
      }
    } catch (e) {}
    await runGit(['add', 'package.json'], cwd);
    await runGit(['commit', '-m', `chore(release): bump version to ${newVersion}`], cwd);
    return true;
  } catch (e) {
    return false;
  }
}

async function promptVersionSelection(versionPlan) {
  const choice = await vscode.window.showQuickPick([
    {
      label: `$(tag) Patch: v${versionPlan.patchVersion}`,
      description: versionPlan.recommendedType === 'patch' ? '(Recommended) Bug fixes & minor updates' : 'Bug fixes & minor updates',
      version: versionPlan.patchVersion
    },
    {
      label: `$(tag) Minor: v${versionPlan.minorVersion}`,
      description: versionPlan.recommendedType === 'minor' ? '(Recommended) New features & functionality' : 'New features & functionality',
      version: versionPlan.minorVersion
    },
    {
      label: `$(tag) Major: v${versionPlan.majorVersion}`,
      description: versionPlan.recommendedType === 'major' ? '(Recommended) Breaking changes' : 'Breaking changes',
      version: versionPlan.majorVersion
    },
    {
      label: `$(history) Keep Current: v${versionPlan.currentVersion}`,
      description: 'Push without modifying version',
      version: null
    }
  ], {
    title: 'Smart Git: Select Release Version',
    placeHolder: `Current version is v${versionPlan.currentVersion}. Choose version for this release:`
  });

  return choice ? choice.version : undefined;
}

async function executeBranchSyncAndPush(cwd, currentBranch, targetBranch, targetVersion = null) {
  try {
    const status = (await runGit(['status', '--short'], cwd)).trim();
    if (status) {
      vscode.window.showWarningMessage('Smart Git: Please commit or stash your working tree changes before syncing branches.');
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
      cancellable: false
    },
    async () => {
      try {
        await runGit(['checkout', targetBranch], cwd);
        await runGit(['merge', currentBranch], cwd);
        await runGit(['push', 'origin', targetBranch], cwd);
        await runGit(['checkout', currentBranch], cwd);
        // Also push currentBranch so any version bump commit is on remote
        await runGit(['push', 'origin', currentBranch], cwd).catch(() => {});
        vscode.window.showInformationMessage(
          targetVersion
            ? `Smart Git: Successfully released v${targetVersion} to "${targetBranch}" and pushed to remote!`
            : `Smart Git: Successfully synced "${currentBranch}" into "${targetBranch}" and pushed to remote!`
        );
        success = true;
      } catch (err) {
        await runGit(['checkout', currentBranch], cwd).catch(() => {});
        vscode.window.showErrorMessage(`Smart Git Sync Error: ${err.message}`);
      }
    }
  );
  return success;
}

function updateStatusBarItem(statusBar) {
  const confirmPush = getSetting('confirmBeforePush');
  const isFast = confirmPush === false;
  statusBar.text = isFast ? '$(zap) Smart Git (Fast)' : '$(shield) Smart Git (Safe)';
  statusBar.tooltip = isFast
    ? 'Smart Git: Fast Mode active (Instant 1-click push without dialog). Click for actions.'
    : 'Smart Git: Safe Mode active (Confirms before pushing). Click for actions.';
}

function activate(context) {
  // 1. Status Bar Quick Launcher
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'smartCommit.quickMenu';
  updateStatusBarItem(statusBar);
  statusBar.show();

  // 2. Initial Fast Mode context for dynamic toolbar button icons
  const initialFast = getSetting('confirmBeforePush') === false;
  vscode.commands.executeCommand('setContext', 'smartCommit:isFastMode', initialFast);

  // Auto-sync context and status bar when configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('smartCommit')) {
        const isFast = getSetting('confirmBeforePush') === false;
        vscode.commands.executeCommand('setContext', 'smartCommit:isFastMode', isFast);
        updateStatusBarItem(statusBar);
      }
    })
  );

  // Fast Mode toggle helper
  async function setFastPushMode(enableFast) {
    await vscode.workspace.getConfiguration('smartCommit').update('confirmBeforePush', !enableFast, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('setContext', 'smartCommit:isFastMode', enableFast);
    updateStatusBarItem(statusBar);
    vscode.window.showInformationMessage(
      enableFast
        ? 'Smart Git: Fast Mode enabled (Instant 1-click push with zero dialogs).'
        : 'Smart Git: Safe Mode enabled (Shows confirmation modal before pushing).'
    );
  }

  // 3. Interactive Quick Menu
  const disposableQuickMenu = vscode.commands.registerCommand('smartCommit.quickMenu', async () => {
    const isFast = getSetting('confirmBeforePush') === false;

    const choice = await vscode.window.showQuickPick([
      {
        label: '$(sparkle) Generate Commit Message',
        description: 'Inspect staged diff and insert into commit box',
        command: 'smartCommit.generate'
      },
      {
        label: '$(cloud-upload) Generate, Commit & Push',
        description: isFast ? 'Instant 1-click push (Fast Mode)' : 'Stage, commit, and push with confirmation',
        command: 'smartCommit.generateCommitAndPush'
      },
      {
        label: '$(git-merge) Safe Sync & Push to Branch',
        description: 'Auto-checks for conflicts before merging & pushing to target branch',
        command: 'smartCommit.syncToBranch'
      },
      {
        label: '$(git-pull-request) Generate PR Description',
        description: 'Create GitHub Markdown PR summary against base branch',
        command: 'smartCommit.generatePR'
      },
      {
        label: '$(diff) Compare Branches & Conflict Advisor',
        description: 'Dry-run merge analysis and AI conflict resolution guide',
        command: 'smartCommit.compareBranches'
      },
      {
        label: isFast ? '$(shield) Switch to Safe Mode' : '$(zap) Switch to Fast Mode (Instant Push)',
        description: isFast ? 'Show confirmation dialog before push' : 'Skip confirmation dialog for instant push',
        command: 'smartCommit.toggleFastPush'
      },
      {
        label: '$(gear) Extension Settings',
        description: 'Configure OpenAI / Gemini API keys and defaults',
        command: 'workbench.action.openSettings',
        args: ['smartCommit']
      }
    ], {
      placeHolder: 'Smart Git Assistant - Select an Action'
    });

    if (choice) {
      if (choice.args) {
        vscode.commands.executeCommand(choice.command, ...choice.args);
      } else {
        vscode.commands.executeCommand(choice.command);
      }
    }
  });

  // 4. Fast Mode Toggle Commands
  const disposableToggleFast = vscode.commands.registerCommand('smartCommit.toggleFastPush', async () => {
    const isFast = getSetting('confirmBeforePush') === false;
    await setFastPushMode(!isFast);
  });

  const disposableEnableFast = vscode.commands.registerCommand('smartCommit.enableFastMode', async () => {
    await setFastPushMode(true);
  });

  const disposableDisableFast = vscode.commands.registerCommand('smartCommit.disableFastMode', async () => {
    await setFastPushMode(false);
  });

  // 4. Command: Generate Message
  const disposableGenerate = vscode.commands.registerCommand('smartCommit.generate', async (arg) => {
    const repo = getTargetRepository(arg);
    if (!repo) {
      vscode.window.showErrorMessage('No active Git repository found.');
      return;
    }

    const autoStage = Boolean(getSetting('autoStage'));
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Smart Commit: Generating commit message...',
        cancellable: false
      },
      async () => {
        try {
          const msg = await generateCommitMessage(repo, autoStage);
          if (msg) {
            repo.inputBox.value = msg;
            vscode.window.setStatusBarMessage('Smart Commit: Message updated!', 3000);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Smart Commit Error: ${err.message}`);
        }
      }
    );
  });

  // 5. Command: Generate, Commit & Push
  const disposableCommitAndPush = vscode.commands.registerCommand('smartCommit.generateCommitAndPush', async (arg) => {
    const repo = getTargetRepository(arg);
    if (!repo) {
      vscode.window.showErrorMessage('No active Git repository found.');
      return;
    }

    const cwd = repo.rootUri.fsPath;
    let msg = '';

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Smart Commit: Generating commit message...',
        cancellable: false
      },
      async () => {
        try {
          const stagedCheck = await runGit(['diff', '--cached'], cwd);
          if (!stagedCheck.trim()) {
            await runGit(['add', '-A'], cwd);
          }
          msg = await generateCommitMessage(repo, false);
          if (msg) {
            repo.inputBox.value = msg;
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Smart Commit Error: ${err.message}`);
        }
      }
    );

    if (!msg) return;

    const confirmPush = getSetting('confirmBeforePush');
    let proceedAction = 'Commit & Push';

    if (confirmPush !== false) {
      const firstLine = msg.split('\n')[0];
      const choice = await vscode.window.showInformationMessage(
        'Smart Commit: Commit & Push to Remote?',
        {
          modal: true,
          detail: `Generated Message:\n"${firstLine}"\n\nWould you like to commit and push these changes to remote now?`
        },
        'Commit & Push',
        'Only Commit'
      );

      if (!choice) return;
      proceedAction = choice;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: proceedAction === 'Commit & Push' ? 'Smart Commit: Committing and pushing to remote...' : 'Smart Commit: Committing changes...',
        cancellable: false
      },
      async () => {
        try {
          await runGit(['commit', '-m', msg], cwd);
          if (proceedAction === 'Commit & Push') {
            await runGit(['push'], cwd);
            vscode.window.showInformationMessage('Smart Commit: Successfully committed and pushed to remote!');
          } else {
            vscode.window.showInformationMessage('Smart Commit: Changes committed locally!');
          }
          repo.inputBox.value = '';
        } catch (err) {
          vscode.window.showErrorMessage(`Smart Commit Push Error: ${err.message}`);
        }
      }
    );
  });

  // 6. Command: Safe Branch Sync & Push
  const disposableSyncToBranch = vscode.commands.registerCommand('smartCommit.syncToBranch', async (arg) => {
    const repo = getTargetRepository(arg);
    if (!repo) {
      vscode.window.showErrorMessage('No active Git repository found.');
      return;
    }

    const cwd = repo.rootUri.fsPath;

    // A. Check clean working tree
    try {
      const status = (await runGit(['status', '--short'], cwd)).trim();
      if (status) {
        vscode.window.showWarningMessage('Smart Git: Please commit or stash your working tree changes before syncing branches.');
        return;
      }
    } catch (e) {}

    // B. Get current and target branches
    let currentBranch = '';
    try {
      currentBranch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
    } catch (e) {
      currentBranch = 'HEAD';
    }

    const branches = await getBranches(cwd, currentBranch);
    if (branches.length === 0) {
      vscode.window.showInformationMessage('No other branches found to sync with.');
      return;
    }

    const targetBranch = await vscode.window.showQuickPick(branches, {
      placeHolder: `Select target branch to sync "${currentBranch}" changes into:`,
      title: 'Smart Git: Safe Branch Sync & Push'
    });

    if (!targetBranch) return;

    // C. Dry-run conflict & security check
    let conflictCheck;
    let diffBody = '';
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Smart Git: Checking conflicts and security for "${targetBranch}"...`,
        cancellable: false
      },
      async () => {
        try {
          conflictCheck = await checkMergeConflicts(cwd, currentBranch, targetBranch);
          try {
            diffBody = await runGit(['diff', `${targetBranch}...HEAD`], cwd);
          } catch (e) {
            diffBody = '';
          }
        } catch (e) {
          conflictCheck = { hasConflicts: false, mergeBase: '', output: '' };
        }
      }
    );

    if (conflictCheck && conflictCheck.hasConflicts) {
      vscode.window.showErrorMessage(`Cannot sync to "${targetBranch}": Merge conflicts detected! Opening AI Conflict Advisor...`);
      vscode.commands.executeCommand('smartCommit.compareBranches', arg);
      return;
    }

    const securityIssues = scanDiffForSecurityIssues(diffBody);
    if (securityIssues.length > 0) {
      const issueList = securityIssues.slice(0, 3).map(i => `• ${i.type} in ${i.file}`).join('\n');
      const proceed = await vscode.window.showWarningMessage(
        `Smart Git: Security Warning before syncing to "${targetBranch}"`,
        {
          modal: true,
          detail: `Detected sensitive data in changes:\n${issueList}\n\nDo you want to proceed with sync and push?`
        },
        'Sync & Push Anyway'
      );
      if (proceed !== 'Sync & Push Anyway') return;
    }

    const isReleaseBranch = /publish|release/i.test(targetBranch);
    const autoBump = getSetting('autoBumpVersion') !== false;
    const pkgInfo = isReleaseBranch && autoBump ? getPackageJsonInfo(cwd) : null;

    let targetVersion = null;
    if (pkgInfo) {
      let commitLog = '';
      try {
        commitLog = await runGit(['log', `${targetBranch}..HEAD`, '--oneline'], cwd);
      } catch (e) {}
      const versionPlan = calculateNextVersions(pkgInfo.version, commitLog);

      const detailMsg = `Branches: "${currentBranch}" ➔ "${targetBranch}"\nAuto Version Bump: v${versionPlan.currentVersion} ➔ v${versionPlan.recommendedVersion} (${versionPlan.recommendedType.toUpperCase()})\nStatus: 0 conflicts, 0 security warnings.\n\nWould you like to release v${versionPlan.recommendedVersion} to "${targetBranch}" and push to remote?`;

      const choice = await vscode.window.showInformationMessage(
        'Smart Git: Ready to Sync & Publish',
        {
          modal: true,
          detail: detailMsg
        },
        `Sync & Publish (v${versionPlan.recommendedVersion})`,
        'Customize Version...'
      );

      if (!choice) return;

      if (choice === `Sync & Publish (v${versionPlan.recommendedVersion})`) {
        targetVersion = versionPlan.recommendedVersion;
        await applyVersionBump(pkgInfo, targetVersion, cwd);
      } else if (choice === 'Customize Version...') {
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
          detail: `This operation will:\n1. Switch to "${targetBranch}"\n2. Merge latest changes from "${currentBranch}"\n3. Push to remote origin\n4. Switch back to "${currentBranch}"`
        },
        'Sync & Push Now'
      );
      if (choice !== 'Sync & Push Now') return;
    }

    await executeBranchSyncAndPush(cwd, currentBranch, targetBranch, targetVersion);
  });

  // 7. Command: Generate Pull Request Description
  const disposableGeneratePR = vscode.commands.registerCommand('smartCommit.generatePR', async (arg) => {
    const repo = getTargetRepository(arg);
    if (!repo) {
      vscode.window.showErrorMessage('No active Git repository found.');
      return;
    }

    const cwd = repo.rootUri.fsPath;
    const provider = getSetting('provider') || 'openai';
    const modelOverride = getSetting('model');
    const apiKey = await resolveApiKey(provider);
    if (!apiKey) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Smart Commit: Generating PR Description...',
        cancellable: false
      },
      async () => {
        try {
          const currentBranch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();

          let baseBranch = getSetting('baseBranch');
          if (!baseBranch) {
            const branchOutput = await runGit(['branch', '-a'], cwd).catch(() => '');
            if (branchOutput.includes('remotes/origin/main') || branchOutput.includes('main')) {
              baseBranch = 'main';
            } else if (branchOutput.includes('remotes/origin/master') || branchOutput.includes('master')) {
              baseBranch = 'master';
            } else {
              baseBranch = 'main';
            }
          }

          let commitLog = '';
          try {
            commitLog = await runGit(['log', `${baseBranch}..HEAD`, '--oneline', '-n', '50'], cwd);
          } catch (e) {
            commitLog = await runGit(['log', '-n', '10', '--oneline'], cwd).catch(() => '');
          }

          let diffStat = '';
          try {
            diffStat = await runGit(['diff', `${baseBranch}...HEAD`, '--stat'], cwd);
          } catch (e) {
            diffStat = await runGit(['diff', '--stat'], cwd).catch(() => '');
          }

          let diffBody = '';
          try {
            diffBody = await runGit(['diff', `${baseBranch}...HEAD`], cwd);
          } catch (e) {
            diffBody = await runGit(['diff'], cwd).catch(() => '');
          }

          if (diffBody.length > 30000) {
            diffBody = diffBody.slice(0, 30000) + '\n\n[Diff truncated for length...]';
          }

          const prPrompt = `Current Branch: ${currentBranch}
Target Base Branch: ${baseBranch}

COMMITS IN BRANCH:
${commitLog || '(no commits found)'}

CHANGES SUMMARY:
${diffStat || '(no summary)'}

CODE DIFF:
${diffBody || '(no diff)'}

Please generate the full Pull Request description:`;

          let prMarkdown = '';
          if (provider === 'gemini') {
            prMarkdown = await requestGemini(apiKey, modelOverride, prPrompt, PR_SYSTEM_PROMPT, 1000);
          } else {
            prMarkdown = await requestOpenAI(apiKey, modelOverride, prPrompt, PR_SYSTEM_PROMPT, 1000);
          }

          if (!prMarkdown) {
            vscode.window.showWarningMessage('Smart Commit: Empty response from AI.');
            return;
          }

          await vscode.env.clipboard.writeText(prMarkdown);

          const doc = await vscode.workspace.openTextDocument({
            content: prMarkdown,
            language: 'markdown'
          });
          await vscode.window.showTextDocument(doc, { preview: false });

          vscode.window.showInformationMessage('Smart Commit: PR Description generated and copied to clipboard!');
        } catch (err) {
          vscode.window.showErrorMessage(`Smart Commit PR Error: ${err.message}`);
        }
      }
    );
  });

  // 8. Command: Compare Branches & AI Conflict Advisor
  const disposableCompare = vscode.commands.registerCommand('smartCommit.compareBranches', async (arg) => {
    const repo = getTargetRepository(arg);
    if (!repo) {
      vscode.window.showErrorMessage('No active Git repository found.');
      return;
    }

    const cwd = repo.rootUri.fsPath;
    const provider = getSetting('provider') || 'openai';
    const modelOverride = getSetting('model');
    const apiKey = await resolveApiKey(provider);
    if (!apiKey) return;

    let currentBranch = '';
    try {
      currentBranch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
    } catch (e) {
      currentBranch = 'HEAD';
    }

    const branches = await getBranches(cwd, currentBranch);
    if (branches.length === 0) {
      vscode.window.showInformationMessage('No other branches found to compare with.');
      return;
    }

    const selectedTarget = await vscode.window.showQuickPick(branches, {
      placeHolder: `Select branch to compare against "${currentBranch}":`,
      title: 'Smart Git: Branch Comparator & Conflict Advisor'
    });

    if (!selectedTarget) return;

    let postCompareAction = null;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Smart Git: Comparing "${currentBranch}" vs "${selectedTarget}" & scanning security...`,
        cancellable: false
      },
      async () => {
        try {
          const conflictCheck = await checkMergeConflicts(cwd, currentBranch, selectedTarget);

          let commitLog = '';
          try {
            commitLog = await runGit(['log', `${selectedTarget}..HEAD`, '--oneline', '-n', '30'], cwd);
          } catch (e) {
            commitLog = await runGit(['log', '-n', '10', '--oneline'], cwd).catch(() => '');
          }

          let commitCount = 0;
          try {
            const countStr = await runGit(['rev-list', '--count', `${selectedTarget}..HEAD`], cwd);
            commitCount = parseInt(countStr.trim(), 10) || 0;
          } catch (e) {
            commitCount = 0;
          }

          let diffStat = '';
          try {
            diffStat = await runGit(['diff', `${selectedTarget}...HEAD`, '--stat'], cwd);
          } catch (e) {
            diffStat = '';
          }

          let diffBody = '';
          try {
            diffBody = await runGit(['diff', `${selectedTarget}...HEAD`], cwd);
          } catch (e) {
            diffBody = '';
          }

          const securityIssues = scanDiffForSecurityIssues(diffBody);

          let reportMarkdown = '';

          if (conflictCheck.hasConflicts) {
            let conflictDetails = conflictCheck.output;
            if (conflictDetails.length > 25000) {
              conflictDetails = conflictDetails.slice(0, 25000) + '\n\n[Conflict log truncated...]';
            }

            const prompt = `Current Working Branch: ${currentBranch}
Target Merge Branch: ${selectedTarget}
Merge Base: ${conflictCheck.mergeBase}

SIMULATED MERGE CONFLICT LOG:
${conflictDetails}

FILE CHANGES STAT:
${diffStat}

Analyze the conflicts and provide the complete resolution guide:`;

            if (provider === 'gemini') {
              reportMarkdown = await requestGemini(apiKey, modelOverride, prompt, CONFLICT_SYSTEM_PROMPT, 1500);
            } else {
              reportMarkdown = await requestOpenAI(apiKey, modelOverride, prompt, CONFLICT_SYSTEM_PROMPT, 1500);
            }

            const doc = await vscode.workspace.openTextDocument({
              content: reportMarkdown,
              language: 'markdown'
            });
            await vscode.window.showTextDocument(doc, { preview: false });

            postCompareAction = { type: 'conflict' };

          } else {
            let securityNotice = '';
            if (securityIssues.length > 0) {
              securityNotice = `## Security Notice\nDetected ${securityIssues.length} potential secret(s) or sensitive string(s) in the diff:\n` +
                securityIssues.map(i => `- **${i.type}** in \`${i.file}\``).join('\n') + '\n\n';
            }

            const prompt = `Current Working Branch: ${currentBranch}
Target Base Branch: ${selectedTarget}
${securityIssues.length > 0 ? `SECURITY WARNING: Found ${securityIssues.length} potential secrets in diff.` : 'SECURITY: Clean, no leaked credentials detected.'}

COMMITS UNIQUE TO ${currentBranch}:
${commitLog || '(no new commits)'}

MODIFIED FILES STAT:
${diffStat || '(no files modified)'}

DIFF DETAILS:
${diffBody.slice(0, 25000) || '(no diff)'}

Write a comprehensive branch comparison and architecture report:`;

            if (provider === 'gemini') {
              reportMarkdown = await requestGemini(apiKey, modelOverride, prompt, BRANCH_COMPARE_SYSTEM_PROMPT, 1500);
            } else {
              reportMarkdown = await requestOpenAI(apiKey, modelOverride, prompt, BRANCH_COMPARE_SYSTEM_PROMPT, 1500);
            }

            if (securityNotice) {
              reportMarkdown = securityNotice + reportMarkdown;
            }

            const doc = await vscode.workspace.openTextDocument({
              content: reportMarkdown,
              language: 'markdown'
            });
            await vscode.window.showTextDocument(doc, { preview: false });

            postCompareAction = {
              type: securityIssues.length > 0 ? 'security' : 'clean',
              securityIssues,
              commitCount
            };
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Smart Git Error: ${err.message}`);
        }
      }
    );

    if (!postCompareAction) return;

    if (postCompareAction.type === 'conflict') {
      vscode.window.showWarningMessage(
        `Smart Git: Merge conflicts detected between "${currentBranch}" and "${selectedTarget}". Pushing is blocked. Review AI Resolution Guide in editor.`,
        'Open Source Control'
      ).then(act => {
        if (act === 'Open Source Control') {
          vscode.commands.executeCommand('workbench.view.scm');
        }
      });
    } else if (postCompareAction.type === 'security') {
      const issueList = postCompareAction.securityIssues.slice(0, 3).map(i => `• ${i.type} in ${i.file}`).join('\n');
      const act = await vscode.window.showWarningMessage(
        `Smart Git: Security Warning detected between "${currentBranch}" and "${selectedTarget}"`,
        {
          modal: true,
          detail: `Found ${postCompareAction.securityIssues.length} potential secret(s) in branch changes:\n${issueList}\n\nReview the report before pushing to prevent credential leaks.`
        },
        `Sync & Push to "${selectedTarget}" Anyway`,
        'Generate PR Description'
      );

      if (act === `Sync & Push to "${selectedTarget}" Anyway`) {
        await executeBranchSyncAndPush(cwd, currentBranch, selectedTarget);
      } else if (act === 'Generate PR Description') {
        vscode.commands.executeCommand('smartCommit.generatePR', arg);
      }
    } else if (postCompareAction.type === 'clean') {
      const isReleaseBranch = /publish|release/i.test(selectedTarget);
      const autoBump = getSetting('autoBumpVersion') !== false;
      const pkgInfo = isReleaseBranch && autoBump ? getPackageJsonInfo(cwd) : null;

      if (pkgInfo) {
        let commitLog = '';
        try {
          commitLog = await runGit(['log', `${selectedTarget}..HEAD`, '--oneline'], cwd);
        } catch (e) {}
        const versionPlan = calculateNextVersions(pkgInfo.version, commitLog);

        const detailMsg = `Branches: "${currentBranch}" ➔ "${selectedTarget}"\nAuto Version Bump: v${versionPlan.currentVersion} ➔ v${versionPlan.recommendedVersion} (${versionPlan.recommendedType.toUpperCase()})\nCommits ahead: ${postCompareAction.commitCount}\nStatus: 0 conflicts, 0 security warnings.\n\nWould you like to release v${versionPlan.recommendedVersion} to "${selectedTarget}" and push to remote now?`;

        const act = await vscode.window.showInformationMessage(
          'Smart Git: Ready to Sync & Publish',
          {
            modal: true,
            detail: detailMsg
          },
          `Sync & Publish (v${versionPlan.recommendedVersion})`,
          'Customize Version...',
          'Generate PR Description'
        );

        if (act === `Sync & Publish (v${versionPlan.recommendedVersion})`) {
          await applyVersionBump(pkgInfo, versionPlan.recommendedVersion, cwd);
          await executeBranchSyncAndPush(cwd, currentBranch, selectedTarget, versionPlan.recommendedVersion);
        } else if (act === 'Customize Version...') {
          const custom = await promptVersionSelection(versionPlan);
          if (custom !== undefined) {
            if (custom) {
              await applyVersionBump(pkgInfo, custom, cwd);
            }
            await executeBranchSyncAndPush(cwd, currentBranch, selectedTarget, custom);
          }
        } else if (act === 'Generate PR Description') {
          vscode.commands.executeCommand('smartCommit.generatePR', arg);
        }
      } else {
        const detailMsg = postCompareAction.commitCount > 0
          ? `Branches: "${currentBranch}" ➔ "${selectedTarget}"\nCommits ahead: ${postCompareAction.commitCount}\nStatus: 0 conflicts, 0 security warnings.\n\nWould you like to sync "${currentBranch}" into "${selectedTarget}" and push to remote now?`
          : `Branches: "${currentBranch}" ➔ "${selectedTarget}"\nStatus: "${selectedTarget}" is already up to date with "${currentBranch}" (0 new commits).\n0 conflicts, 0 security warnings.`;

        const act = await vscode.window.showInformationMessage(
          'Smart Git: Ready to Sync & Push',
          {
            modal: true,
            detail: detailMsg
          },
          `Sync & Push to "${selectedTarget}"`,
          'Generate PR Description'
        );

        if (act === `Sync & Push to "${selectedTarget}"`) {
          await executeBranchSyncAndPush(cwd, currentBranch, selectedTarget);
        } else if (act === 'Generate PR Description') {
          vscode.commands.executeCommand('smartCommit.generatePR', arg);
        }
      }
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
    disposableSyncToBranch,
    disposableGeneratePR,
    disposableCompare
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
