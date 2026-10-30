# Smart Commit Generator

**Fast, accurate, and context-aware Git commit messages powered by OpenAI & Google Gemini.**

---

## Why Smart Commit Generator?

Traditional AI commit generators often inspect entire files or guess from file names, resulting in generic summaries or hallucinated features. **Smart Commit Generator** inspects your exact staged diff (`git diff --cached`) line-by-line to produce concise, meaningful Conventional Commits in under 400ms.

---

## Features

- **Strict Diff Inspection**: Reads your exact line additions and deletions—never assumes changes from file names or unrelated code.
- **Conventional Commits**: Produces standardized headers (`feat`, `fix`, `refactor`, `perf`, `docs`, `chore`, etc.) under 72 characters, with optional bullet points for multi-part edits.
- **Dual AI Engine**: Seamlessly switch between **OpenAI** (`gpt-4o-mini`) and **Google Gemini** (`gemini-3.8-flash`).
- **Interactive Setup**: No manual configuration files required. If an API key is missing, a one-click prompt lets you paste your key directly in the editor.
- **100% Private & Local**: Your API keys stay on your machine. API calls are made directly to OpenAI/Google with zero telemetry or intermediate servers.

---

## Usage

### Method 1: Source Control Panel
1. Open the **Source Control** view (`Ctrl+Shift+G`).
2. Stage your changes with `+` (or leave unstaged—the generator checks unstaged diffs as fallback).
3. Click the **sparkle icon** on the **Changes** header.
4. Your commit message will instantly populate the commit message box!

### Method 2: Keyboard Shortcut
Press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>G</kbd> (<kbd>Cmd</kbd> + <kbd>Alt</kbd> + <kbd>G</kbd> on macOS) anywhere in the editor.

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

---

## License

MIT © Hessam Barasm Mamagani

