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
# ⚠️ Merge Conflict Analysis & Resolution Guide

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
# 🔍 Branch Comparison & Architecture Report

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
  const globalConfig = vscode.workspace.getConfiguration();
  let val = config.get(key) || globalConfig.get(`smartCommit.${key}`);
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

  // 1. If triggered from a specific repository toolbar in SCM
  if (arg) {
    const uri = arg.rootUri || (arg.repository && arg.repository.rootUri);
    if (uri) {
      const match = api.repositories.find(r => r.rootUri.fsPath.toLowerCase() === uri.fsPath.toLowerCase());
      if (match) return match;
    }
  }

  // 2. If an editor document is open, match its repository
  const activeDocUri = vscode.window.activeTextEditor?.document?.uri;
  if (activeDocUri) {
    const match = api.repositories.find(r => activeDocUri.fsPath.toLowerCase().startsWith(r.rootUri.fsPath.toLowerCase()));
    if (match) return match;
  }

  // 3. Fallback to active repository or first in list
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

function activate(context) {
  // 1. Status Bar Quick Launcher
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(sparkle) Smart Git';
  statusBar.tooltip = 'Smart Git Assistant (Click for actions)';
  statusBar.command = 'smartCommit.quickMenu';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // 2. Interactive Quick Menu
  const disposableQuickMenu = vscode.commands.registerCommand('smartCommit.quickMenu', async () => {
    const choice = await vscode.window.showQuickPick([
      {
        label: '$(sparkle) Generate Commit Message',
        description: 'Inspect staged diff and insert into commit box',
        command: 'smartCommit.generate'
      },
      {
        label: '$(cloud-upload) Generate, Commit & Push',
        description: 'One-click auto-stage, AI message, commit and remote push',
        command: 'smartCommit.generateCommitAndPush'
      },
      {
        label: '$(git-pull-request) Generate PR Description',
        description: 'Create GitHub Markdown PR summary against base branch',
        command: 'smartCommit.generatePR'
      },
      {
        label: '$(git-compare) Compare Branches & Conflict Advisor',
        description: 'Dry-run merge analysis and AI conflict resolution guide',
        command: 'smartCommit.compareBranches'
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

  // 3. Command: Generate Message
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

  // 4. Command: Generate, Commit & Push (Modal prompt that never disappears)
  const disposableCommitAndPush = vscode.commands.registerCommand('smartCommit.generateCommitAndPush', async (arg) => {
    const repo = getTargetRepository(arg);
    if (!repo) {
      vscode.window.showErrorMessage('No active Git repository found.');
      return;
    }

    const cwd = repo.rootUri.fsPath;
    let msg = '';

    // Step A: Stage & Generate Message
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

    // Step B: Confirmation (Using modal dialog so buttons never auto-dismiss)
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

      if (!choice) return; // User cancelled or closed dialog
      proceedAction = choice;
    }

    // Step C: Execute Commit & Push with dedicated progress
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

  // 5. Command: Generate Pull Request Description
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

  // 6. Command: Compare Branches & AI Conflict Advisor
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

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Smart Git: Comparing "${currentBranch}" vs "${selectedTarget}"...`,
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

          if (diffBody.length > 25000) {
            diffBody = diffBody.slice(0, 25000) + '\n\n[Diff truncated for length...]';
          }

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

            vscode.window.showWarningMessage(
              `Smart Git: Merge conflicts detected between "${currentBranch}" and "${selectedTarget}". AI Resolution Guide opened!`,
              'View Source Control'
            ).then(act => {
              if (act === 'View Source Control') {
                vscode.commands.executeCommand('workbench.view.scm');
              }
            });

          } else {
            const prompt = `Current Working Branch: ${currentBranch}
Target Base Branch: ${selectedTarget}

COMMITS UNIQUE TO ${currentBranch}:
${commitLog || '(no new commits)'}

MODIFIED FILES STAT:
${diffStat || '(no files modified)'}

DIFF DETAILS:
${diffBody || '(no diff)'}

Write a comprehensive branch comparison and architecture report:`;

            if (provider === 'gemini') {
              reportMarkdown = await requestGemini(apiKey, modelOverride, prompt, BRANCH_COMPARE_SYSTEM_PROMPT, 1500);
            } else {
              reportMarkdown = await requestOpenAI(apiKey, modelOverride, prompt, BRANCH_COMPARE_SYSTEM_PROMPT, 1500);
            }

            const doc = await vscode.workspace.openTextDocument({
              content: reportMarkdown,
              language: 'markdown'
            });
            await vscode.window.showTextDocument(doc, { preview: false });

            vscode.window.showInformationMessage(
              `Smart Git: Branches compared cleanly with 0 conflicts!`,
              'Generate PR Description'
            ).then(act => {
              if (act === 'Generate PR Description') {
                vscode.commands.executeCommand('smartCommit.generatePR');
              }
            });
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Smart Git Error: ${err.message}`);
        }
      }
    );
  });

  context.subscriptions.push(
    statusBar,
    disposableQuickMenu,
    disposableGenerate,
    disposableCommitAndPush,
    disposableGeneratePR,
    disposableCompare
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
