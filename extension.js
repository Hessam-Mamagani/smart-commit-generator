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

function getGitRepository() {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) return null;
  const api = gitExtension.exports.getAPI(1);
  if (!api || !api.repositories || api.repositories.length === 0) return null;

  const activeDocUri = vscode.window.activeTextEditor?.document?.uri;
  if (activeDocUri) {
    const found = api.repositories.find(r => activeDocUri.fsPath.startsWith(r.rootUri.fsPath));
    if (found) return found;
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

function requestOpenAI(apiKey, model, userContent, systemPrompt = SYSTEM_PROMPT) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.2,
      max_tokens: 600
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

function requestGemini(apiKey, model, userContent, systemPrompt = SYSTEM_PROMPT) {
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
        maxOutputTokens: 600
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

function activate(context) {
  // Command 1: Generate Message
  const disposableGenerate = vscode.commands.registerCommand('smartCommit.generate', async () => {
    const repo = getGitRepository();
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

  // Command 2: Generate, Commit & Push
  const disposableCommitAndPush = vscode.commands.registerCommand('smartCommit.generateCommitAndPush', async () => {
    const repo = getGitRepository();
    if (!repo) {
      vscode.window.showErrorMessage('No active Git repository found.');
      return;
    }

    const cwd = repo.rootUri.fsPath;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Smart Commit: Preparing Commit & Push...',
        cancellable: false
      },
      async () => {
        try {
          // 1. Stage all changes if nothing staged
          const stagedCheck = await runGit(['diff', '--cached'], cwd);
          if (!stagedCheck.trim()) {
            await runGit(['add', '-A'], cwd);
          }

          // 2. Generate commit message
          const msg = await generateCommitMessage(repo, false);
          if (!msg) return;

          repo.inputBox.value = msg;

          // 3. Confirm before push (if enabled)
          const confirmPush = getSetting('confirmBeforePush');
          const shouldConfirm = confirmPush !== false;

          if (shouldConfirm) {
            const firstLine = msg.split('\n')[0];
            const choice = await vscode.window.showInformationMessage(
              `Generated: "${firstLine}"\nCommit and push now?`,
              'Commit & Push',
              'Only Commit',
              'Cancel'
            );

            if (choice === 'Commit & Push') {
              await runGit(['commit', '-m', msg], cwd);
              await runGit(['push'], cwd);
              repo.inputBox.value = '';
              vscode.window.showInformationMessage('Smart Commit: Successfully committed and pushed to remote!');
            } else if (choice === 'Only Commit') {
              await runGit(['commit', '-m', msg], cwd);
              repo.inputBox.value = '';
              vscode.window.showInformationMessage('Smart Commit: Changes committed successfully!');
            }
          } else {
            await runGit(['commit', '-m', msg], cwd);
            await runGit(['push'], cwd);
            repo.inputBox.value = '';
            vscode.window.showInformationMessage('Smart Commit: Successfully committed and pushed to remote!');
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Smart Commit Error: ${err.message}`);
        }
      }
    );
  });

  // Command 3: Generate Pull Request Description
  const disposableGeneratePR = vscode.commands.registerCommand('smartCommit.generatePR', async () => {
    const repo = getGitRepository();
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
            prMarkdown = await requestGemini(apiKey, modelOverride, prPrompt, PR_SYSTEM_PROMPT);
          } else {
            prMarkdown = await requestOpenAI(apiKey, modelOverride, prPrompt, PR_SYSTEM_PROMPT);
          }

          if (!prMarkdown) {
            vscode.window.showWarningMessage('Smart Commit: Empty response from AI.');
            return;
          }

          // 1. Copy to clipboard
          await vscode.env.clipboard.writeText(prMarkdown);

          // 2. Open in new Markdown editor
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

  context.subscriptions.push(disposableGenerate, disposableCommitAndPush, disposableGeneratePR);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
