# Change Log

All notable changes to the "Smart Commit Generator AI" extension will be documented in this file.

## [1.1.0] - 2026-10-31

### Added
- **One-Click Commit & Push**: Added `Smart Commit: Generate, Commit & Push` action (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd>) and dedicated Source Control toolbar button (`$(cloud-upload)`).
- **Pull Request Description Generator**: Added `Smart Commit: Generate PR Description` (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> or toolbar icon `$(git-pull-request)`) to generate comprehensive GitHub Markdown PR descriptions with summary, changes, testing, and checklist.
- **Safety Prompt**: Configurable confirmation prompt (`smartCommit.confirmBeforePush`) before pushing commits to remote.
- **Base Branch Detection**: Added `smartCommit.baseBranch` setting with automatic detection for `main` and `master`.

---

## [1.0.0] - 2026-10-31

### Initial Release
- Instant AI Git commit message generation from staged diffs.
- Dual-engine support for OpenAI (`gpt-4o-mini`) and Google Gemini (`gemini-3.8-flash`).
- Conventional Commits specification formatting.
- Interactive API key setup directly inside the editor.
- Source Control panel integration and keyboard shortcuts (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd>).
