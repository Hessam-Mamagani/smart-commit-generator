# Smart Commit Generator AI

**Fast, accurate, and context-aware Git commit messages and Pull Request descriptions powered by OpenAI & Google Gemini.**

---

## Why Smart Commit Generator AI?

Traditional AI commit tools often inspect entire files or guess from file names, resulting in generic summaries or hallucinated features. **Smart Commit Generator AI** inspects your exact staged diff (`git diff --cached`) line-by-line to produce concise, meaningful Conventional Commits in under 400ms.

---

## Features

- **Strict Diff Inspection**: Reads your exact line additions and deletions—never assumes changes from file names or unrelated code.
- **Conventional Commits**: Produces standardized headers (`feat`, `fix`, `refactor`, `perf`, `docs`, `chore`, etc.) under 72 characters, with optional bullet points for multi-part edits.
- **One-Click Commit & Push**: Stage, generate, commit, and push to your remote repository in a single click with built-in preview and safety confirmation.
- **Pull Request (PR) Generator**: Compares your working branch against `main` or `master` to generate a comprehensive markdown PR description with summary, key changes, and verification checklist.
- **Dual AI Engine**: Seamlessly switch between **OpenAI** (`gpt-4o-mini`) and **Google Gemini** (`gemini-3.8-flash`).
- **Interactive Setup**: No manual configuration files required. If an API key is missing, a one-click prompt lets you paste your key directly in the editor.
- **100% Private & Local**: Your API keys stay on your machine. API calls are made directly to OpenAI/Google with zero telemetry or intermediate servers.

---

## Usage

### 1. Generate Commit Message
- **Source Control View**: Click the **sparkle icon** (`$(sparkle)`) on the Source Control title bar.
- **Shortcut**: Press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>G</kbd> (<kbd>Cmd</kbd> + <kbd>Alt</kbd> + <kbd>G</kbd> on macOS).

### 2. Generate, Commit & Push (One-Click)
- **Source Control View**: Click the **cloud upload icon** (`$(cloud-upload)`) on the Source Control title bar.
- **Shortcut**: Press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>P</kbd> (<kbd>Cmd</kbd> + <kbd>Alt</kbd> + <kbd>P</kbd> on macOS).
- Automatically stages modified files, generates the commit message, and prompts to commit and push to remote.

### 3. Generate Pull Request Description
- **Source Control View**: Click the **git pull request icon** (`$(git-pull-request)`).
- **Command Palette**: Run `Smart Commit: Generate PR Description`.
- Automatically opens a new Markdown document with your formatted PR summary and copies it to your clipboard.

---

## Configuration

Open your IDE Settings (<kbd>Ctrl</kbd> + <kbd>,</kbd>) and search for `smartCommit`:

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `smartCommit.provider` | `string` | `"openai"` | AI provider (`"openai"` or `"gemini"`). |
| `smartCommit.openaiApiKey` | `string` | `""` | Your OpenAI API key (`sk-proj-...`). |
| `smartCommit.geminiApiKey` | `string` | `""` | Your Google Gemini API key. |
| `smartCommit.model` | `string` | `""` | Optional model override (defaults: `gpt-4o-mini` / `gemini-3.8-flash`). |
| `smartCommit.autoStage` | `boolean` | `false` | Automatically stage all modified files if nothing is staged before generating. |
| `smartCommit.confirmBeforePush` | `boolean` | `true` | Show a confirmation prompt with message preview before pushing to remote. |
| `smartCommit.baseBranch` | `string` | `""` | Target base branch for PR description generation (auto-detected if empty). |

---

## License

MIT © Hessam Barasm Mamagani
