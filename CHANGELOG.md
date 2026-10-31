# Change Log

All notable changes to the "Smart Commit Generator AI" extension will be documented in this file.

## [1.3.0] - 2026-10-31

### Added
- **Safe Branch Sync & Push (`$(repo-sync)`)**: Sync and push changes from your working branch into any target branch (e.g., `publish`, `dev`, `staging`). Checks for merge conflicts in memory first with `git merge-tree`; only merges and pushes if clean, otherwise alerts you and opens the AI Conflict Advisor.
- **⚡ Fast Mode vs 🛡️ Safe Mode Dynamic Toggle**: 1-click button in the Source Control title bar and status bar that visually switches between `$(shield)` (Safe Mode) and `$(zap)` (Fast Mode) in real time. Fast Mode stages, generates, commits, and pushes instantly with zero dialogs. Safe Mode shows the review modal before pushing.
- **Dynamic Status Bar**: Displays current operating mode (`$(zap) Smart Git (Fast)` vs `$(shield) Smart Git (Safe)`) with quick-action launcher.
- **New Shortcuts**: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> for Safe Branch Sync & Push, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd> for Toggle Fast Mode.

---

## [1.2.1] - 2026-10-31

### Fixed & Improved
- **Persistent Confirmation Dialog**: Switched "Commit & Push" confirmation prompt to a modal dialog so buttons never auto-dismiss or disappear before clicking.
- **Multi-Repository Precision**: Accurately targets the clicked repository when multiple repositories are open in the Source Control panel.
- **Dedicated Progress Indicator**: Added separate progress notification during git commit and push operations.

---

## [1.2.0] - 2026-10-31

### Added
- **Smart Branch Compare & AI Conflict Advisor**: Added `Smart Commit: Compare Branches & Conflict Advisor` command (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd>) and Source Control header button (`$(git-compare)`).
- **Status Bar Quick Launcher**: Added persistent `$(sparkle) Smart Git` status bar button for one-click access to all actions and settings.
- **Interactive Quick Menu**: Fast command selection with descriptive summaries.
- **Enhanced Documentation**: Comprehensive workflow guide, shortcut reference, and marketplace badges.

---

## [1.1.0] - 2026-10-31

### Added
- **One-Click Commit & Push**: Added `Smart Commit: Generate, Commit & Push` action (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd>) and dedicated Source Control toolbar button (`$(cloud-upload)`).
- **Pull Request Description Generator**: Added `Smart Commit: Generate PR Description` (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> or toolbar icon `$(git-pull-request)`).

---

## [1.0.0] - 2026-10-31

### Initial Release
- Instant AI Git commit message generation from staged diffs.
- Dual-engine support for OpenAI (`gpt-4o-mini`) and Google Gemini (`gemini-3.8-flash`).
- Conventional Commits specification formatting.
