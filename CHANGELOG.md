# Change Log

All notable changes to the "Smart Commit Generator AI" extension will be documented in this file.

## [1.4.6] - 2026-11-01

### Added & Changed
- **GPLv3 License Protection**: Switched project license from MIT to GNU General Public License v3.0 (GPL-3.0) to protect the software from closed-source commercial exploitation while keeping it fully public and open-source.
- **Fixed Marketplace Badges**: Replaced deprecated Shields.io badge with `vsmarketplacebadges.dev` to resolve the "retired badge" error.
- **Automated Release Changelog Generation**: Integrated automatic commit log parsing into the release flow to keep `CHANGELOG.md` up-to-date with every version bump.

---

## [1.4.5] - 2026-11-01

### Added & Improved
- **Outgoing Commits Tracker (GitHub Desktop-style)**: Added a dedicated, collapsible **OUTGOING COMMITS** card directly above Changes showing all local commits waiting to be pushed, with commit hashes, messages, relative timestamps, and active count badge.
- **One-Click Push for Pending Commits**: Dedicated `⬆ Push` header button and clickable `↑ N to push` status bar pill to push outgoing commits directly to the remote repository. Automatically configures upstream tracking if missing.
- **Undo Last Commit (`↶ Undo`)**: Inline soft reset (`git reset --soft HEAD~1`) action on the latest pending commit. Safely uncommits changes back into the Staged area and restores the commit message into the text editor so you can edit it or regenerate with AI.
- **One-Click Local Commit (`[ 1 + 2 ]`)**: Clicking **Commit Only** with an empty message now automatically stages files and generates the commit message using AI before committing locally without pushing.
- **High-Contrast Slate Navy Styling**: Upgraded the **Commit Only** button to a refined Slate Navy design (`#252b37` with crisp border and high-contrast text), eliminating the inactive washed-out grey appearance.

---

## [1.4.4] - 2026-11-01

### Added & Improved
- **Real-Time Git State Synchronization**: Subscribed to VS Code Git extension repository events (`repo.state.onDidChange`, `onDidOpenRepository`) to automatically reflect branch, staging, and commit changes across all views with debounced refresh.
- **Document Save Change Detection**: Automatically updates the uncommitted changes list whenever files are saved.

---

## [1.4.3] - 2026-11-01

### Added & Improved
- **Enhanced Branch Switching**: Interactive checkout with branch sorting by recent committer date and dedicated "Create new branch..." prompt.

---

## [1.4.2] - 2026-11-01

### Added
- **Per-File Accept & Discard Actions**: One-click **Stage / Accept** (`+` to stage, active green `✓` to unstage) and **Discard Changes** (`↶` with safety confirmation modal) directly from the Changes file explorer list.
- **Batch Stage All & Discard All**: Added header quick-action buttons (`+` Stage All, `↶` Discard All) alongside the file counter badge.
- **Dynamic Safe / Fast Mode Chip Iconography**: Integrated vector shield (`🛡️`) and lightning (`⚡`) icons inside the Safe / Fast Mode pill in the header bar.

---

## [1.4.0] - 2026-11-01

### Added

- **Dedicated Smart Git AI Dashboard & Activity Bar View**: Unified sidebar webview panel accessible from both the Activity Bar and the Source Control view. Features an interactive commit message editor, live character counter, one-click clear, and action buttons.
- **Interactive Changed Files Explorer**: Live file status list with an active blue counter badge chip. Directly open files in your editor (`📄`), or launch a side-by-side git diff against `HEAD` (`⧉` or clicking `M`/`U`/`A`/`D` badge).
- **Interactive Branch Switcher**: Click `Branch: <name> ▾` in the dashboard status bar to view local and remote branches in a QuickPick, switch branches instantly, or create and checkout a new branch on the fly.
- **Multi-Repository Switcher**: Effortlessly switch active repository in multi-root workspaces via `Repo: <name> ▾`.
- **Grok (xAI) AI Engine**: Full support for xAI Grok completions (`grok-2-latest`).
- **Google Gemini 3.8-Flash**: Updated default Gemini model to `gemini-3.8-flash` for the latest speed and intelligence.
- **Pre-Flight Debug Artifact Protection**: Scans staged and working diffs for stray `console.log`, `debugger`, `print()`, or `var_dump()` calls before committing, with automated false-positive filtering for string and regex definitions.
- **Refined Vector Iconography**: Brand new, hollow-ring SVGs across all action buttons ("Safe Sync", "Draft PR", "Compare Branches") modeled on clean GitHub and Git aesthetics.

---

## [1.3.0] - 2026-10-31

### Added

- **Automated Semver Version Bumping**: When syncing or releasing to `publish` (or release branches), the extension automatically inspects conventional commits, recommends the appropriate semver bump (Patch for fixes/chores, Minor for features, Major for breaking changes), updates `package.json`, and commits the release bump with 1-click.
- **Interactive Branch Comparison with Security Scan & Direct Push**: Branch comparison (`$(diff)`) now runs a live pre-merge conflict check and security audit (detects API keys, tokens, and private keys). If clean, provides direct 1-click actions: **Sync & Push**, **Generate PR Description**, or **Cancel**. If conflicts exist, blocks pushing and guides resolution.
- **Safe Branch Sync & Push (`$(git-merge)`)**: Sync and push changes from your working branch into any target branch (e.g., `publish`, `dev`, `staging`). Checks for merge conflicts in memory first with `git merge-tree`; only merges and pushes if clean, otherwise alerts you and opens the AI Conflict Advisor.
- **Fast Mode vs Safe Mode Dynamic Toggle**: 1-click button in the Source Control title bar and status bar that visually switches between `$(shield)` (Safe Mode) and `$(zap)` (Fast Mode) in real time. Fast Mode stages, generates, commits, and pushes instantly with zero dialogs. Safe Mode shows the review modal before pushing.
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
