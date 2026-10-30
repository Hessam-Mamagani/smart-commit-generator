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

function getSetting(key) {
  const config = vscode.workspace.getConfiguration('smartCommit');
  const globalConfig = vscode.workspace.getConfiguration();
  let val = config.get(key) || globalConfig.get(`smartCommit.${key}`);
  if (val) return val;

  // Fail-safe direct read from settings.json
  try {
    const candidates = [
      path.join(process.env.APPDATA || '', 'Antigravity IDE', 'User', 'settings.json'),
      path.join(process.env.APPDATA || '', 'Antigravity', 'User', 'settings.json')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const reg = new RegExp(`"smartCommit\\.${key}"\\s*:\\s*"([^"]+)"`);
        const m = raw.match(reg);
        if (m && m[1]) return m[1];
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

function requestOpenAI(apiKey, model, diffText) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Analyze this git diff and produce the commit message:\n\n${diffText}` }
      ],
      temperature: 0.2,
      max_tokens: 350
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

function requestGemini(apiKey, model, diffText) {
  return new Promise((resolve, reject) => {
    const modelName = model || 'gemini-3.8-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const payload = JSON.stringify({
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents: [
        { parts: [{ text: `Analyze this git diff and produce the commit message:\n\n${diffText}` }] }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 350
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

function activate(context) {
  const disposable = vscode.commands.registerCommand('smartCommit.generate', async () => {
    const repo = getGitRepository();
    if (!repo) {
      vscode.window.showErrorMessage('No active Git repository found.');
      return;
    }

    const cwd = repo.rootUri.fsPath;
    const provider = getSetting('provider') || 'openai';
    const openaiKey = getSetting('openaiApiKey');
    const geminiKey = getSetting('geminiApiKey');
    const modelOverride = getSetting('model');
    const autoStage = Boolean(getSetting('autoStage'));

    let apiKey = provider === 'gemini' ? geminiKey : openaiKey;
    if (!apiKey) {
      if (provider === 'openai' && geminiKey) {
        apiKey = geminiKey;
      } else if (provider === 'gemini' && openaiKey) {
        apiKey = openaiKey;
      }
    }

    // Interactive Key Setup for users
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
          return;
        }
      } else if (choice === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'smartCommit');
        return;
      } else {
        return;
      }
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Generating commit message (${provider})...`,
        cancellable: false
      },
      async () => {
        try {
          // 1. Check staged changes
          let stagedDiff = await runGit(['diff', '--cached'], cwd);
          let statSummary = '';

          if (!stagedDiff.trim() && autoStage) {
            await runGit(['add', '-A'], cwd);
            stagedDiff = await runGit(['diff', '--cached'], cwd);
          }

          let diffContent = '';
          if (stagedDiff.trim()) {
            statSummary = await runGit(['diff', '--cached', '--stat'], cwd);
            diffContent = `STAGED CHANGES SUMMARY:\n${statSummary}\n\nSTAGED DIFF:\n${stagedDiff}`;
          } else {
            // Check unstaged changes
            const unstagedDiff = await runGit(['diff'], cwd);
            if (unstagedDiff.trim()) {
              statSummary = await runGit(['diff', '--stat'], cwd);
              diffContent = `UNSTAGED CHANGES SUMMARY:\n${statSummary}\n\nUNSTAGED DIFF:\n${unstagedDiff}`;
            } else {
              // Check untracked files
              const status = await runGit(['status', '--short'], cwd);
              if (!status.trim()) {
                vscode.window.showInformationMessage('Smart Commit: No changes detected to commit.');
                return;
              }
              diffContent = `UNTRACKED / MODIFIED FILES STATUS:\n${status}`;
            }
          }

          if (diffContent.length > 30000) {
            diffContent = diffContent.slice(0, 30000) + '\n\n[Diff truncated for length...]';
          }

          let commitMessage = '';
          if (provider === 'gemini') {
            commitMessage = await requestGemini(apiKey, modelOverride, diffContent);
          } else {
            commitMessage = await requestOpenAI(apiKey, modelOverride, diffContent);
          }

          if (commitMessage) {
            repo.inputBox.value = commitMessage;
            vscode.window.setStatusBarMessage('Smart Commit: Message updated!', 3000);
          } else {
            vscode.window.showWarningMessage('Smart Commit: Empty response from AI.');
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Smart Commit Error: ${err.message}`);
        }
      }
    );
  });

  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
