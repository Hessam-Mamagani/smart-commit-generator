# Change Log

All notable changes to the "Smart Commit Generator AI" extension will be documented in this file.

## [1.2.1] - 2026-10-31

### Fixed & Improved
- **Persistent Confirmation Dialog**: Switched "Commit & Push" confirmation prompt to a modal dialog so buttons never auto-dismiss or disappear before clicking.
- **Multi-Repository Precision**: Accurately targets the clicked repository when multiple repositories are open in the Source Control panel.
- **Dedicated Progress Indicator**: Added separate progress notification during git commit and push operations.

---

## [1.2.0] - 2026-10-31

### Added
- **Smart Branch Compare & AI Conflict Advisor**: Added `Smart Commit: Compare Branches & Conflict Advisor` command (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd>) and Source Control header button (`$(git-compare)`).
  - Dry-run merge conflict detection using `git merge-tree`.
  - Non-destructive conflict analysis explaining both branch changes and providing production-ready merged code blocks.
  - Architecture and Risk Assessment report for clean merges.
- **Status Bar Quick Launcher**: Added persistent `$(sparkle) Smart Git` status bar button for one-click access to all actions and settings.
- **Interactive Quick Menu**: Fast command selection with descriptive summaries.
- **Enhanced Documentation**: Comprehensive workflow guide, shortcut reference, and marketplace badges.

---

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
