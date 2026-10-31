# Smart Commit Generator AI

[![Version](https://img.shields.io/visual-studio-marketplace/v/Hessam-Mamagani.smart-commit-generator-ai?style=flat-square&color=blue&label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=Hessam-Mamagani.smart-commit-generator-ai)
[![Open VSX](https://img.shields.io/open-vsx/v/Hessam-Mamagani/smart-commit-generator-ai?style=flat-square&color=purple&label=Open%20VSX)](https://open-vsx.org/extension/Hessam-Mamagani/smart-commit-generator-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE.txt)

**Fast, accurate, and context-aware Git assistant for VS Code, Cursor, and Antigravity IDE. Generate conventional commits, one-click commit & push, sync branches safely, draft comprehensive Pull Request descriptions, and resolve branch merge conflicts with OpenAI & Google Gemini.**

---

## Key Features

- **Strict Diff Inspection**: Reads your exact line additions and deletions—never assumes changes from file names or unrelated code.
- **Conventional Commits**: Produces standardized headers (`feat`, `fix`, `refactor`, `perf`, `docs`, `chore`, etc.) under 72 characters, with optional bullet points for multi-part edits.
- **⚡ Fast Mode vs 🛡️ Safe Mode Toggle**: Switch between instant 1-click push (zero dialogs) and safe review mode with a single click.
- **Safe Branch Sync & Push (`$(repo-sync)`)**: Automatically verifies zero merge conflicts in memory with `git merge-tree` before syncing and pushing changes to any target branch (e.g. `publish`, `dev`, `staging`).
- **One-Click Commit & Push**: Stage, generate, commit, and push to your remote repository in a single click with built-in preview and safety confirmation.
- **Pull Request (PR) Generator**: Compares your working branch against `main` or `master` to generate a comprehensive markdown PR description with summary, key changes, and verification checklist.
- **Branch Compare & AI Conflict Advisor**: Dry-run merge check between any two branches. Identifies conflicts before they happen and provides production-ready merged code solutions.
- **Status Bar Launcher**: Permanent `$(sparkle) Smart Git` status bar button displaying current mode with one-click access to all tools.
- **Dual AI Engine**: Seamlessly switch between **OpenAI** (`gpt-4o-mini`, `gpt-4o`) and **Google Gemini** (`gemini-3.8-flash`, `gemini-2.5-pro`).
- **Interactive Setup**: No manual configuration files required. If an API key is missing, a one-click prompt lets you paste your key directly in the editor.
- **100% Private & Local**: Your API keys stay on your machine. API calls are made directly to OpenAI/Google with zero telemetry or intermediate servers.

---

## Source Control Toolbar Actions

![Smart Git Source Control Toolbar](images/toolbar.png)

Six dedicated action buttons are built right into your **Source Control** view header:

|   #   |          Icon          | Action                       |                    Shortcut                     | Description                                                                                |
| :---: | :--------------------: | :--------------------------- | :---------------------------------------------: | :----------------------------------------------------------------------------------------- |
| **1** |      `$(sparkle)`      | **Generate Message**         | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>G</kbd> | Inspects staged diff and populates the commit box with Conventional Commits.               |
| **2** |   `$(cloud-upload)`    | **Generate, Commit & Push**  | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>P</kbd> | Stages modified files, generates message, commits, and pushes to remote in 1 click.        |
| **3** |     `$(git-merge)`     | **Safe Sync to Branch**      | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>S</kbd> | Conflict-safe branch merge & push with auto semver release bump (e.g. `main` ➔ `publish`). |
| **4** | `$(git-pull-request)`  | **Generate PR Description**  |                        —                        | Drafts full markdown Pull Request description and copies to clipboard.                     |
| **5** |       `$(diff)`        | **Compare & Security Audit** | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>C</kbd> | Compares branches, checks conflicts, scans for leaked API keys, and offers 1-click push.   |
| **6** | `$(shield)` / `$(zap)` | **Toggle Fast / Safe Mode**  | <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>T</kbd> | Flips visually between Safe Mode (modal confirmation) and Fast Mode (instant push).        |

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

1. Click the **sync icon** (`$(repo-sync)`) or press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>S</kbd>.
2. Select your target branch (e.g., `publish` to release, or `staging`).
3. The extension tests for merge conflicts in memory:
   - **Zero conflicts**: Safely switches, merges, pushes to remote, and returns to your working branch.
   - **Conflicts detected**: Aborts before touching files and opens the AI Conflict Advisor.

### 4. Pull Request Description Generator

1. Click the **git pull request icon** (`$(git-pull-request)`).
2. The AI compares your working branch against `main` or `master`.
3. Copies full Markdown PR to your clipboard and opens in a new tab.

### 5. Branch Compare, Security Audit & Direct Push

1. Click the **git compare icon** (`$(git-compare)`) or press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>C</kbd>.
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

Open Settings (<kbd>Ctrl</kbd> + <kbd>,</kbd>) and search for `smartCommit`:

| Setting                         | Type      | Default    | Description                                                                       |
| :------------------------------ | :-------- | :--------- | :-------------------------------------------------------------------------------- |
| `smartCommit.provider`          | `string`  | `"openai"` | AI provider: `"openai"` or `"gemini"`.                                            |
| `smartCommit.openaiApiKey`      | `string`  | `""`       | OpenAI API key (`sk-proj-...`).                                                   |
| `smartCommit.geminiApiKey`      | `string`  | `""`       | Google Gemini API key.                                                            |
| `smartCommit.model`             | `string`  | `""`       | Optional model override (e.g. `gpt-4o`, `gemini-2.5-pro`).                        |
| `smartCommit.autoStage`         | `boolean` | `false`    | Automatically stage all modified files if nothing is staged before generating.    |
| `smartCommit.confirmBeforePush` | `boolean` | `true`     | When true: Safe Mode (shows modal). When false: Fast Mode (instant 1-click push). |
| `smartCommit.baseBranch`        | `string`  | `""`       | Target base branch for PR generator (auto-detects `main` or `master` if empty).   |

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

MIT © [Hessam Barasm Mamagani](https://github.com/Hessam-Mamagani)
