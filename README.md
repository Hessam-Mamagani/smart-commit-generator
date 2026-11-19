# Smart Commit Generator AI

[![VS Marketplace](https://vsmarketplacebadges.dev/version/Hessam-Mamagani.smart-commit-generator-ai.svg?style=flat-square&color=blue&label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=Hessam-Mamagani.smart-commit-generator-ai)
[![Open VSX](https://img.shields.io/open-vsx/v/Hessam-Mamagani/smart-commit-generator-ai?style=flat-square&color=purple&label=Open%20VSX)](https://open-vsx.org/extension/Hessam-Mamagani/smart-commit-generator-ai)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg?style=flat-square)](LICENSE)

**Fast, accurate, and context-aware Git assistant for VS Code, Cursor, and Antigravity IDE. Generate conventional commits, one-click commit & push, sync branches safely, draft comprehensive Pull Request descriptions, and resolve branch merge conflicts with Built-in IDE AI (Copilot), Google Gemini, Groq, Anthropic Claude, OpenAI, OpenRouter, DeepSeek, Grok (xAI), local Ollama, or any OpenAI-compatible endpoint.**

---

## Quick Demo

![Smart Commit Generator AI Demo](https://raw.githubusercontent.com/Hessam-Mamagani/smart-commit-generator/main/media/demo.gif)

---

## Key Features

- **Dedicated Smart Git AI Dashboard & Activity Bar Badge**: Unified Activity Bar and Source Control panel with a live changes counter badge on the Activity Bar icon, interactive commit editor, real-time character counter, and instant one-click actions.
- **Strict Diff Inspection**: Reads your exact line additions and deletions—never assumes changes from file names or unrelated code.
- **Conventional Commits**: Produces standardized headers (`feat`, `fix`, `refactor`, `perf`, `docs`, `chore`, etc.) under 72 characters, with optional bullet points for multi-part edits.
- **Interactive Changed Files Explorer**: Live list of uncommitted changed files with an active blue counter badge. Click any file or `📄` to open the file directly in the editor; click `⧉` or the status badge (`M`, `U`, `A`, `D`) to view a side-by-side diff against `HEAD`.
- **Interactive Branch Switcher**: Click `Branch: <name> ▾` in the dashboard to switch local or remote branches instantly, or create and checkout new branches on the fly.
- **Multi-Repository Switcher**: Click `Repo: <name> ▾` to switch active workspaces with zero hassle.
- **Pre-Flight Debug Artifact Protection**: Automatically scans diffs for leftover `console.log`, `debugger`, `print()`, or `var_dump()` calls before committing.
- **Fast Mode vs Safe Mode Toggle**: Switch between instant 1-click push (zero dialogs) and safe review mode with a single click.
- **Safe Branch Sync & Push (`$(git-merge)`)**: Automatically verifies zero merge conflicts in memory with `git merge-tree` before syncing and pushing changes to any target branch (e.g. `publish`, `dev`, `staging`) with auto semver bumping.
- **One-Click Commit & Push**: Stage, generate, commit, and push to your remote repository in a single click with built-in preview and safety confirmation.
- **Pull Request (PR) Generator**: Compares your working branch against `main` or `master` to generate a comprehensive markdown PR description with summary, key changes, and verification checklist.
- **Branch Compare & AI Conflict Advisor**: Dry-run merge check between any two branches. Identifies conflicts before they happen and provides production-ready merged code solutions.
- **Status Bar Launcher**: Permanent `$(sparkle) Smart Git` status bar button displaying current mode with one-click access to all tools.
- **Multi-AI Engine**: Seamlessly switch between **Google Gemini** (`gemini-3.8-flash`), **Built-in IDE AI / Copilot** (zero API key via `vscode.lm`), **Groq** (ultra-fast LPU), **Ollama** (local, offline, zero API key), **Anthropic Claude** (`claude-haiku-5-5`), **OpenRouter**, **Grok (xAI)**, **DeepSeek**, **OpenAI**, and **Custom OpenAI-Compatible** endpoints (LM Studio, Azure, vLLM, LiteLLM).
- **Smart Lockfile & Artifact Filtering**: Automatically excludes noisy files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `dist/`, `*.min.js`) from raw diffs so real code changes are never truncated.
- **Custom Language, Gitmoji & Prompts**: Generate commit messages and PR descriptions in your preferred language, optionally add Gitmoji prefixes, and append team-specific prompt instructions.
- **Encrypted API Key Storage**: API keys are stored securely in VS Code's encrypted `SecretStorage` (never plaintext `settings.json`). All API calls go directly from your machine to your selected provider with zero intermediate servers.

---

## Source Control Toolbar Actions

![Smart Git Source Control Toolbar](https://raw.githubusercontent.com/Hessam-Mamagani/smart-commit-generator/main/images/toolbar.png)

Six dedicated action buttons are built right into your **Source Control** view header:

|   #   |                                                               Button                                                                | Action                       |       Shortcut        | Description                                                                                |
| :---: | :---------------------------------------------------------------------------------------------------------------------------------: | :--------------------------- | :-------------------: | :----------------------------------------------------------------------------------------- |
| **1** |     ![Generate](https://raw.githubusercontent.com/Hessam-Mamagani/smart-commit-generator/main/images/icons/btn-1-generate.png)      | **Generate Message**         | <kbd>Ctrl+Alt+G</kbd> | Inspects staged diff and populates the commit box with Conventional Commits.               |
| **2** | ![Commit & Push](https://raw.githubusercontent.com/Hessam-Mamagani/smart-commit-generator/main/images/icons/btn-2-commit-push.png)  | **Generate, Commit & Push**  | <kbd>Ctrl+Alt+P</kbd> | Stages modified files, generates message, commits, and pushes to remote in 1 click.        |
| **3** |   ![Safe Sync](https://raw.githubusercontent.com/Hessam-Mamagani/smart-commit-generator/main/images/icons/btn-3-branch-sync.png)    | **Safe Sync to Branch**      | <kbd>Ctrl+Alt+S</kbd> | Conflict-safe branch merge & push with auto semver release bump (e.g. `main` ➔ `publish`). |
| **4** |  ![Generate PR](https://raw.githubusercontent.com/Hessam-Mamagani/smart-commit-generator/main/images/icons/btn-4-generate-pr.png)   | **Generate PR Description**  |           —           | Drafts full markdown Pull Request description and copies to clipboard.                     |
| **5** |  ![Compare & Audit](https://raw.githubusercontent.com/Hessam-Mamagani/smart-commit-generator/main/images/icons/btn-5-compare.png)   | **Compare & Security Audit** | <kbd>Ctrl+Alt+C</kbd> | Compares branches, checks conflicts, scans for leaked API keys, and offers 1-click push.   |
| **6** | ![Fast Mode Toggle](https://raw.githubusercontent.com/Hessam-Mamagani/smart-commit-generator/main/images/icons/btn-6-fast-mode.png) | **Toggle Fast / Safe Mode**  | <kbd>Ctrl+Alt+T</kbd> | Flips visually between Safe Mode (modal confirmation) and Fast Mode (instant push).        |

---

## Supported AI Engines & Free Options

Smart Commit Generator AI connects directly to your preferred AI model. Multiple supported options require **zero credit card or zero API key**:

| Provider                     |       Cost        | Setup                                                                  | Default Model                | Key Highlight                                                              |
| :--------------------------- | :---------------: | :--------------------------------------------------------------------- | :--------------------------- | :------------------------------------------------------------------------- |
| **Google Gemini**            |   **Free Tier**   | Free key at [Google AI Studio](https://aistudio.google.com/app/apikey) | `gemini-3.8-flash`           | Default provider with free tier (subject to Google AI Studio daily caps).  |
| **Built-in IDE AI (Copilot)**| **Included / 0 Key** | Uses active VS Code Language Model (VS Code 1.90+)                  | Auto-selected fast model     | Zero API key setup — reuses your existing Copilot subscription natively.   |
| **Groq**                     |   **Free Tier**   | Free key at [Groq Console](https://console.groq.com)                   | `llama-3.3-70b-versatile`    | Ultra-fast LPU inference (~200ms sub-second generation).                   |
| **Ollama**                   |   **100% Free**   | Install from [ollama.com](https://ollama.com)                          | `llama3.2`                   | Runs locally & offline. Zero API key, 100% private.                        |
| **Anthropic Claude**         | **Pay-As-You-Go** | API key at [Anthropic Console](https://console.anthropic.com)          | `claude-haiku-5-5`           | Fast, sharp code reasoning from Anthropic.                                 |
| **OpenAI**                   | **Pay-As-You-Go** | API key at [OpenAI Platform](https://platform.openai.com)              | `gpt-4o-mini`                | Industry standard GPT models.                                              |
| **OpenRouter**               | **Pay-As-You-Go** | API key at [OpenRouter](https://openrouter.ai/keys)                    | `openai/gpt-4o-mini`         | Access 200+ frontier & open-source models with one key.                    |
| **DeepSeek**                 |  **Ultra Cheap**  | API key at [DeepSeek Platform](https://platform.deepseek.com)          | `deepseek-chat`              | Strong coding intelligence at very low token cost.                         |
| **Grok (xAI)**               | **Pay-As-You-Go** | API key at [xAI Console](https://console.x.ai)                         | `grok-4.20-0309-non-reasoning` | Fast non-reasoning Grok 4 model from xAI.                                |
| **Custom OpenAI-Compatible** | **Self-Hosted / Any** | Set `smartCommit.customBaseUrl`                                    | `gpt-4o-mini` (overrideable) | Works with LM Studio, Azure OpenAI, vLLM, LiteLLM, or company proxies.     |

> **Security Note**: API keys are stored encrypted using VS Code's built-in **Secret Storage** (`Smart Git: Manage API Keys`). Any legacy keys saved in `settings.json` are automatically migrated and cleared.

> **Tip for Ollama**: Simply run `ollama run llama3.2` in your terminal and select `"ollama"` as your provider. No API key or internet access required.

---

## Detailed Workflows

### 1. Generating a Commit Message

1. Open the **Source Control** panel (<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>G</kbd>).
2. Stage your changes (`+`), or leave them unstaged—the extension checks unstaged diffs as fallback.
3. Click the **sparkle icon** (`$(sparkle)`) on your repository header or press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>G</kbd>.
4. Your commit message will appear in the commit input box instantly.

### 2. One-Click Commit & Push

1. Click the **cloud upload icon** (`$(cloud-upload)`) or press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>P</kbd>.
2. In **Safe Mode**: A modal dialog previews the message and lets you confirm.
3. In **Fast Mode**: Immediately stages, commits, and pushes to remote with zero dialogs.

### 3. Safe Branch Sync & Push

1. Click the **safe branch sync icon** (`$(git-merge)`) or press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>S</kbd>.
2. Select your target branch (e.g., `publish` to release, or `staging`).
3. The extension tests for merge conflicts in memory:
   - **Zero conflicts**: Safely switches, merges, pushes to remote, and returns to your working branch.
   - **Conflicts detected**: Aborts before touching files and opens the AI Conflict Advisor.

### 4. Pull Request Description Generator

1. Click the **git pull request icon** (`$(git-pull-request)`).
2. The AI compares your working branch against `main` or `master`.
3. Copies full Markdown PR to your clipboard and opens in a new tab.

### 5. Branch Compare, Security Audit & Direct Push

1. Click the **branch compare icon** (`$(diff)`) or press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>C</kbd>.
2. Select any target branch to compare against.
3. Automatically runs:
   - **Merge conflict dry-run** (`git merge-tree`).
   - **Security scanner** for leaked credentials, API keys, or private tokens.
   - **AI Architecture & Risk report** opened in your editor.
4. If clean and ready, provides direct 1-click modal actions:
   - **`Sync & Push to "<branch>"`**: Automatically merges and pushes right from the comparison!
   - **`Generate PR Description`**: Formats ready-to-paste PR markdown.
   - **`Cancel`**: Closes modal and keeps report open.
5. If conflicts exist, blocks pushing and provides step-by-step resolution guidance.

---

## Configuration

Open Settings (<kbd>Ctrl</kbd> + <kbd>,</kbd>) and search for `smartCommit`, or run **`Smart Git: Manage API Keys (Secure Storage)`** from the Command Palette (<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>) to store API keys encrypted:

| Setting                         | Type       | Default                    | Description                                                                                                       |
| :------------------------------ | :--------- | :------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| `smartCommit.provider`          | `string`   | `"gemini"`                 | `"gemini"`, `"vscode-lm"`, `"groq"`, `"ollama"`, `"claude"`, `"openai"`, `"openrouter"`, `"deepseek"`, `"grok"`, or `"custom"`. |
| `smartCommit.model`             | `string`   | `""`                       | Optional model override (e.g. `gpt-4o`, `claude-sonnet-5-5`, `deepseek-chat`, `llama3.2`).                        |
| `smartCommit.ollamaEndpoint`    | `string`   | `"http://localhost:11434"` | Local Ollama endpoint URL (runs offline, zero API key).                                                           |
| `smartCommit.customBaseUrl`     | `string`   | `""`                       | Base URL for Custom OpenAI-compatible provider (e.g. `http://localhost:1234/v1`).                                 |
| `smartCommit.commitLanguage`    | `string`   | `"English"`                | Language for commit descriptions and PR summaries (Conventional Commit prefixes stay in English).                 |
| `smartCommit.useGitmoji`        | `boolean`  | `false`                    | Prefix generated commit headers with a matching Gitmoji symbol.                                                   |
| `smartCommit.customPrompt`      | `string`   | `""`                       | Optional extra rules appended to the commit system prompt.                                                        |
| `smartCommit.excludeFromDiff`   | `string[]` | Lockfiles & build outputs  | Glob patterns excluded from raw diffs sent to AI so lockfiles never crowd out source code changes.                |
| `smartCommit.autoStage`         | `boolean`  | `false`                    | Automatically stage all modified files if nothing is staged before generating.                                    |
| `smartCommit.confirmBeforePush` | `boolean`  | `true`                     | When true: Safe Mode (shows modal). When false: Fast Mode (instant 1-click push).                                 |
| `smartCommit.baseBranch`        | `string`   | `""`                       | Target base branch for PR generator (auto-detects `main` or `master` if empty).                                   |
| `smartCommit.autoBumpVersion`   | `boolean`  | `true`                     | Automatically calculate and bump semver in `package.json` when syncing to release/publish branches.               |

---

## Keyboard Shortcuts

| Shortcut (Windows/Linux)                        | Shortcut (macOS)                               | Command                                           |
| :---------------------------------------------- | :--------------------------------------------- | :------------------------------------------------ |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>G</kbd> | <kbd>Cmd</kbd> + <kbd>Alt</kbd> + <kbd>G</kbd> | Smart Commit: Generate Message                    |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>P</kbd> | <kbd>Cmd</kbd> + <kbd>Alt</kbd> + <kbd>P</kbd> | Smart Commit: Generate, Commit & Push             |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>S</kbd> | <kbd>Cmd</kbd> + <kbd>Alt</kbd> + <kbd>S</kbd> | Smart Commit: Safe Branch Sync & Push             |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>C</kbd> | <kbd>Cmd</kbd> + <kbd>Alt</kbd> + <kbd>C</kbd> | Smart Commit: Compare Branches & Conflict Advisor |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>T</kbd> | <kbd>Cmd</kbd> + <kbd>Alt</kbd> + <kbd>T</kbd> | Smart Commit: Toggle Fast Push / Safe Mode        |

---

## License

GPL-3.0 © [Hessam Barasm Mamagani](https://github.com/Hessam-Mamagani)
