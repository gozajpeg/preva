<div align="center">
  <img src="https://raw.githubusercontent.com/gozajpeg/preva/main/assets/preva.webp" alt="preva logo" width="380" />
  <h1>preva</h1>
  <p><strong>Same Git, just with a preview.</strong></p>
  <p>Preva doesn't change how Git works. It just shows you what's happening before you stage, commit, or push, so you can catch mistakes before they leave your machine.</p>

  <p>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square" alt="node version" /></a>
    <a href="https://www.npmjs.com/package/preva-cli"><img src="https://img.shields.io/badge/npm-preva--cli-red.svg?style=flat-square" alt="npm package" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="license" /></a>
    <a href="https://github.com/gozajpeg"><img src="https://img.shields.io/badge/author-gozajpeg-blue.svg?style=flat-square" alt="author" /></a>
  </p>
</div>

---

### Overview

Preva doesn't change how Git works. It runs normal Git commands, but gives you a preview first so you don't push the wrong files by accident:

1. **Interactive Staging (`preva add`)**: Pick which files to stage from a checklist instead of running `git add .` blindly. Common secret files like `.env` start unchecked.
2. **Conventional Commits (`preva commit`)**: Pick standard commit types (`feat`, `fix`, `docs`, etc.) to keep your commit history clean and consistent.
3. **Pre-Push Review (`preva push`)**: See your unpushed commits and the exact files you're about to push, with an alert if any secret files got committed. Validates remote protocol and catches typos before pushing.
4. **Branch Manager (`preva branch`)**: Switch, create, rename, or delete branches with safety previews that inspect merge status and unmerged commits before deletion.
5. **Safe Restore (`preva restore`)**: Safely unstage files with `--staged` or inspect exact diff line deletions before permanently discarding local edits.
6. **Safe Reset & Undo (`preva reset`)**: Preview soft unwraps (`--soft`), mixed resets, and hard resets (`--hard`) with clear warnings listing files that will be affected.
7. **Untracked File Cleaner (`preva clean`)**: Safely inspect and delete untracked files with file sizes and sensitive file protections before permanent removal.

---

### Terminal Previews

#### 1. Interactive Staging (`preva git add .`)

Instead of staging everything blindly with `git add .`, run:

```bash
preva git add .
# or shorthand:
preva add .
```

`preva` scans your repository changes and displays an interactive checklist:

![preva git add preview](https://raw.githubusercontent.com/gozajpeg/preva/main/assets/add.webp)

- **Normal changes** start pre-checked so common staging stays fast.
- **Sensitive files** (patterns like `*.key`, `*.pem`, `.env*`, `credentials.json`, `*.p12`) start **unchecked** by default.
- Use **arrow keys** or **j/k** to navigate, **Space** to toggle, **a** to toggle all, and **Enter** to confirm.
- Only the files you confirm will be staged with native `git add`.

You can also target specific folders or paths:

```bash
preva git add src/
preva git add config/
```

---

#### 2. Conventional Commit Generator (`preva git commit`)

Write clean, consistent Conventional Commits with interactive selectable types and pre-filled formatting:

```bash
preva git commit
# or shorthand:
preva commit
```

`preva` reviews your staged changes, lets you select standard commit types, prompts for an optional scope, and previews the formatted message:

![preva git commit preview](https://raw.githubusercontent.com/gozajpeg/preva/main/assets/commit.webp)

- **Standard Types**: Pre-fills the 11 standard types from Conventional Commits v1.0.0 and `@commitlint/config-conventional`.
- **Automatic Formatting**: Normalizes scopes to lowercase and auto-strips trailing periods so commits pass CI linters without friction.
- **Breaking Changes**: Automatically appends the standard exclamation mark `!` (e.g. `feat(api)!: remove v1 endpoint`) when a breaking change is confirmed.
- **Safety**: Warns if nothing is staged and suggests running `preva git add .` first.
- **Flag Pass-through**: Passes through native Git commit flags (e.g. `preva commit --amend` or `preva commit -m "custom message"`).

---

#### 3. Pre-Push Review (`preva git push`)

Before pushing your branch, run:

```bash
preva git push origin main
# or shorthand:
preva push
```

`preva` inspects the unpushed commits and presents a clear summary:

![preva git push preview](https://raw.githubusercontent.com/gozajpeg/preva/main/assets/push.webp)

- If flagged files are detected, the confirmation prompt defaults to **No (`[y/N]`)**.
- Pressing **n**, **Enter**, or **Ctrl+C** cleanly cancels the push without sending anything to the remote.
- When cancelled, `preva` prints the command to uncommit the file if you need to adjust it:
  ```bash
  To uncommit and adjust before pushing:
     git reset --soft HEAD~1
     preva git add .
     preva commit
  ```
- Validates the destination remote URL protocol before prompting and catches typos (like `gttps://`).

---

#### 4. Branch Manager & Safety Guard (`preva git branch`)

Safely manage local branches with merge inspection and unmerged commit warnings:

```bash
preva git branch
# or shorthand:
preva branch
```

- **Interactive Menu**: Switch branches, create new branches, rename branches, or delete branches without memorizing Git flags.
- **Merge Status Guard**: Before deleting, Preva checks if the branch is merged into your active branch. If unmerged, it shows the list of commits that would be lost and defaults the confirmation prompt to **No (`[y/N]`)**.
- **Working Tree Check**: Warns if uncommitted changes exist in your working tree before switching branches.
- **Flag Pass-through**: Also previews direct Git branch commands like `preva branch -d <branch>`, `preva branch -D <branch>`, and `preva branch -M <new-name>`.

---

#### 5. Safe Restore & Discard Guard (`preva git restore`)

Safely unstage files or inspect the exact lines about to be discarded:

```bash
preva git restore --staged <files...>  # Unstage files (100% safe)
preva git restore <files...>           # Discard local edits (shows diff preview)
# or shorthand interactive menu:
preva restore
```

- **Unstaging (`--staged`)**: Moves files out of the staging index while keeping every edit in your working directory.
- **Discard Guard**: When discarding uncommitted changes, Preva prints the file diff snippet and line counts, requiring confirmation before permanently erasing changes.

---

#### 6. Safe Reset & Commit Unwrap Guard (`preva git reset` / `preva undo`)

Preview the exact consequences of Git resets before any pointer moves:

```bash
preva git reset --soft HEAD~1   # Unwrap commit back into staging index (safe)
preva git reset --mixed HEAD~1  # Unwrap commit into working tree
preva git reset --hard HEAD     # Destructive reset (shows files that will be lost)
# or shorthand interactive menu:
preva reset
# or alias:
preva undo
```

- **Explicit Flags in Menu**: The interactive menu displays the native Git flags (`--soft`, `--mixed`, `--hard`) directly alongside each option to keep the learning curve low.
- **Hard Reset Guard**: If running `--hard`, Preva lists all uncommitted files that will be permanently lost and defaults the confirmation prompt to **No (`[y/N]`)**.

---

#### 7. Untracked File Cleaner (`preva git clean`)

Safely inspect and delete untracked files with file sizes and sensitive file protections:

```bash
preva git clean -n        # Dry run: previews what would be cleaned without deleting
preva git clean -f        # Force clean: previews files and sizes before deletion
# or shorthand interactive menu:
preva clean
```

- **Interactive Checklist**: Displays untracked files with calculated file sizes (`KB`, `MB`). Files start unchecked for safety.
- **Sensitive File Protection**: Flags sensitive files (like `.env`, credentials, or keys) so they are not accidentally wiped out.
- **Confirmation Default**: Prompts default to **No (`[y/N]`)** before any untracked file is permanently deleted from disk.

---

#### 8. Pre-Pull Review & Conflict Guard (`preva git pull`)

Safely preview incoming commits, changed files, and detect potential merge conflicts before updating your branch:

```bash
preva git pull                   # Fetch and inspect incoming commits & files
preva git pull origin main       # Pull from specific remote and branch
preva git pull --rebase          # Replay local commits on top of incoming commits
preva git pull --ff-only         # Fast-forward only; aborts if diverged
# or shorthand:
preva pull
```

- **Silent Background Fetch**: Runs a read-only `git fetch` to inspect upstream changes without altering your working directory or branch.
- **Incoming Commits Preview**: Lists incoming commits with commit hashes, authors, relative timestamps, and commit messages.
- **Changed Files List**: Previews files modified upstream with status badges (`M`, `A`, `D`, `R`).
- **Conflict Pre-Check Guard**: Automatically compares incoming files against your local uncommitted edits. If an overlap is detected, Preva warns you before Git aborts or creates a conflict.
- **Pull Strategies**: Interactive menu lets you choose between Fast-forward (`--ff-only`), Rebase (`--rebase`), or standard Merge commit (`--no-rebase`).

---

#### 9. Pre-Merge Review & Conflict Inspector (`preva git merge`)

Safely preview commits, changed files, and detect potential merge conflicts before combining branches:

```bash
preva git merge                  # Interactive branch selector & merge preview
preva git merge feature-auth     # Preview merging specific branch into current
preva git merge --squash feat    # Squash merge preview (single commit)
preva git merge --ff-only feat   # Fast-forward only preview
preva git merge --abort          # Abort an in-progress merge conflict cleanly
# or shorthand:
preva merge
```

- **Interactive Branch Picker**: Displays local branches with latest commit messages to choose which branch to merge.
- **Already Merged Detection**: Confirms if the target branch is already fully merged into your active branch.
- **Incoming Commits & File Diffs**: Lists all commits and modified files incoming from the target branch with status badges (`M`, `A`, `D`, `R`).
- **Conflict Pre-Check Guard**: Inspects common ancestor commits (`git merge-base`) to identify any files modified on both branches simultaneously before you merge.
- **In-Progress Merge Helper**: If a merge conflict is currently active, Preva detects `.git/MERGE_HEAD` and offers an easy one-click abort (`git merge --abort`) or commit helper.

---

#### 10. Safe Stash Explorer & Drop Guard (`preva git stash`)

Inspect stash contents and prevent accidental permanent deletion of uncommitted code:

```bash
preva git stash                  # Interactive stash explorer and manager
preva git stash list             # List all saved stashes with timestamps
preva git stash push -m "WIP"    # Preview files before saving stash
preva git stash show stash@{0}   # Inspect files and diff snippet inside stash
preva git stash pop stash@{0}    # Conflict check & preview before popping
preva git stash drop stash@{0}   # Destructive guard: preview files before drop
preva git stash clear            # Critical guard: confirm before deleting all stashes
# or shorthand:
preva stash
```

- **Inspect Before Pop / Apply**: View full file lists and colorized unified diffs inside any stash without having to apply it first.
- **Conflict Pre-Check Guard**: Checks if files in the stash overlap with your current uncommitted working tree edits, preventing ugly stash merge collisions.
- **Destructive Drop Guard**: Native `git stash drop` erases code forever with no prompt. Preva lists the files that will be permanently lost and defaults confirmation to **No (`[y/N]`)**.
- **Clear All Guard**: Requires explicit confirmation before wiping all saved stashes.

---

#### 11. Interactive Visual Diff Explorer (`preva git diff`)

Explore changes visually with file-by-file inspection, line change statistics, and instant staging shortcuts without terminal scrollback overflow:

```bash
preva git diff                   # Interactive diff explorer across working tree
preva git diff --stat            # Visual change summary table with (+add / -del)
preva git diff --staged          # Inspect staged changes ready to be committed
preva git diff HEAD              # Inspect staged and unstaged changes combined
preva git diff src/index.js      # Inspect single-file diff with stage/restore shortcuts
preva git diff main..feature     # Branch and range comparison inspector
# or shorthand:
preva diff
```

- **Scope Selector**: Effortlessly switch between unstaged changes (`git diff`), staged changes (`git diff --staged`), and combined uncommitted changes (`git diff HEAD`).
- **File Breakdown & Line Stats**: Clean tabular summary showing modified files, status badges (`[M]`, `[A]`, `[D]`, `[R]`), and colored additions/deletions (`+149 / -1`).
- **Interactive File Inspection**: Select any file from the menu to inspect its colorized unified diff with clean hunk headers without dumping hundreds of lines into terminal scrollback.
- **Instant Action Shortcuts**: Stage a file (`git add <file>`), unstage a file (`git restore --staged <file>`), or safely discard changes (`git restore <file>`) directly from the diff view.
- **Branch & Commit Comparisons**: Pick any local or remote branch to inspect file differences and commit deltas (`git diff <branch>...HEAD`).
- **Untracked File Awareness**: Proactively displays untracked file counts that native `git diff` silently hides, guiding you when files need to be staged.

---

#### 12. Repository Health Dashboard & Action Hub (`preva git status`)

Get an instant, structured overview of your repository health and jump directly into staging, committing, syncing, or cleaning with a single keypress:

```bash
preva git status                 # Interactive repository health dashboard & action hub
preva git status -s              # Fast compact summary dashboard
# or shorthand:
preva status
```

- **Branch & Upstream Sync**: Live tracking shows your active branch and ahead / behind commit counts relative to upstream (`origin/main`).
- **In-Progress State Detection**: Instantly spots active merges (`MERGE_HEAD`), rebases (`rebase-merge`), cherry-picks, reverts, and bisects with one-click abort helpers.
- **Staged & Unstaged Breakdown**: Colorized file status badges (`[M]`, `[A]`, `[D]`, `[R]`) with added and deleted line statistics (`(+25 / -2)`).
- **Untracked Files & Secret Shield**: Displays file sizes and highlights any sensitive credential files (`.env`, `*.pem`, `credentials.json`) before you accidentally stage them.
- **Interactive Action Hub**: Launch directly into `preva commit`, `preva diff`, `preva add`, `preva push`, `preva pull`, or `preva clean` without retyping commands.

---

#### 13. Pre-Rebase Review & Conflict Inspector (`preva git rebase`)

Eliminate rebase anxiety with commit-by-commit previews, conflict pre-checks, auto-stash protection, and active rebase recovery:

```bash
preva git rebase                 # Interactive upstream branch selector & rebase preview
preva git rebase main            # Preview replaying branch commits onto main
preva git rebase -i HEAD~3       # Interactive rebase guide & cheat sheet
preva git rebase --continue      # Continue rebase after resolving conflict
preva git rebase --abort         # 100% safe rewind to state before rebase started
preva git rebase --skip          # Skip current commit patch and advance
# or shorthand:
preva rebase
```

- **Commit Replay Preview**: Lists every local commit about to be replayed in chronological order with commit hashes, authors, and dates.
- **Conflict Pre-Check Guard**: Inspects divergence against common ancestor (`git merge-base`) to identify overlapping files modified on both branches before history rewriting begins.
- **Auto-Stash Safety Shield**: Warns if uncommitted changes exist in your working directory and offers one-click safe auto-stashing before rebasing.
- **Active Rebase Recovery Helper**: When a rebase hits a conflict, Preva detects in-progress steps (`rebase-merge`) and displays unmerged files alongside guided one-click actions (`--continue`, `--skip`, `--abort`).
- **Interactive Rebase Cheat Sheet**: Explains interactive editor commands (`pick`, `reword`, `edit`, `squash`, `fixup`, `drop`) before opening the interactive editor.

#### 14. Visual Commit History Browser & Inspector (`preva git log`)

Explore commit history visually with formatted commit tables, per-file diff statistics, inline patch inspector, and interactive branch navigation:

```bash
preva git log                    # Interactive commit explorer & visual browser
preva git log -n 10              # View latest 10 commits in clean visual table
preva git log --oneline          # Compact one-line commit log
preva git log <hash>             # Direct inspector for commit hash or branch
# or shorthand:
preva log
```

- **Visual Commit Table**: Colorized commit hashes, relative timestamps, author names, branch and tag decorations (`HEAD -> main`, `origin/main`), and commit subjects.
- **Detailed Commit Inspector**: View author details, exact timestamps, full commit message body, modified files with status badges (`[M]`, `[A]`, `[D]`, `[R]`), and per-file diff stats (`+lines / -lines`).
- **Inline Patch Preview**: Inspect syntax-colored diff patches for any individual commit directly in your terminal.
- **Interactive Commit Explorer**: Search and filter commits by message keyword (`git log --grep`), filter by author name (`git log --author`), inspect commit changes, or safely soft reset (`git reset --soft`) back to a previous commit.

#### 15. Pre-Cherry-Pick Review & Conflict Safeguard (`preva git cherry-pick`)

Preview individual commit patches and inspect merge conflicts before applying them to your active branch:

```bash
preva git cherry-pick                # Interactive commit explorer across branches
preva git cherry-pick <hash>         # Preview commit details, files, and patch
preva git cherry-pick -n <hash>      # Apply changes into staging index without committing
preva git cherry-pick --continue     # Continue cherry-pick after resolving conflicts
preva git cherry-pick --abort        # 100% safe rewind to state before cherry-pick started
preva git cherry-pick --skip         # Skip current commit patch and advance
# or shorthand:
preva cherry-pick
```

- **Commit Patch Safety Preview**: View full commit details, author info, exact timestamps, and a syntax-colored diff patch preview before any commit is applied.
- **Conflict Pre-Check Guard**: Analyzes target commit files against the current branch and working directory to flag potential merge conflicts before execution.
- **Auto-Stash Working Tree Protection**: Detects uncommitted changes in your workspace and offers one-click safe auto-stashing before cherry-picking, automatically restoring afterwards.
- **Flexible Execution Modes**: Apply with original commit message, apply without committing (`-n`), edit commit message (`-e`), or add signed-off-by trailer (`-s`).
- **Active Cherry-Pick Recovery Helper**: When conflicts occur, Preva identifies unmerged files and provides one-click recovery options (`--continue`, `--skip`, `--abort`).

#### 16. Visual Tag Browser, Creator & Deletion Guard (`preva git tag`)

Browse, create, and manage release tags with visual metadata, collision safeguards, and delete protections:

```bash
preva git tag                    # Interactive tag browser and management hub
preva git tag -l "v1.*"          # List tags matching glob pattern
preva git tag -a v1.2.0 -m "msg" # Create annotated release tag directly
preva git tag -d v1.2.0          # Delete local tag with confirmation safeguard
# or shorthand:
preva tag
```

- **Visual Tag Explorer**: Formatted table of repository tags with annotated/lightweight status badges, commit associations, timestamps, tagger info, and annotation notes.
- **Detailed Tag Inspector**: Inspect tag metadata, annotation body, target commit subject, and unified commit patch.
- **Interactive Tag Creation Wizard**: Step-by-step tag creator with automatic collision checks, annotated vs lightweight options, and commit selector (`HEAD` or previous commits).
- **Accidental Deletion Safeguards**: Protects against accidental deletion of local tags (`-d`) and remote tags (`--delete`) with explicit confirmation dialogs.
- **Remote Push Integration**: Directly publish created tags to your default remote repository (`origin`).

#### 17. Pre-Clone Review & Directory Collision Guard (`preva git clone`)

Preview target folder paths, branch settings, shallow depths, and avoid directory collisions before downloading repositories:

```bash
preva git clone <url> [directory]    # Pre-flight clone review with collision guard
preva git clone --depth 1 <url>      # Fast shallow clone preview
preva git clone -b <branch> <url>    # Clone specific branch
preva git clone                      # Interactive clone wizard
# or shorthand:
preva clone
```

- **Destination Collision Guard**: Pre-checks destination directory before Git starts cloning. If the target folder already exists and contains files, Preva warns you and suggests non-colliding alternatives (e.g. `repo-1`) or custom folder names instead of failing with a native Git fatal error.
- **Interactive Setup Wizard**: Run without arguments to trigger an interactive wizard prompting for repository URL, folder destination, and clone depth modes (Standard Full Clone, Shallow `--depth 1`, or Recursive with Submodules).
- **Post-Clone Tech Detection & Next Steps**: Automatically inspects cloned project files to detect development stacks (Node.js, Rust, Go, Python, Java) and prints recommended commands (e.g. `npm install`, `cargo build`).

#### 18. Pre-Revert Safety Preview & Merge Guard (`preva git revert`)

Preview inverted patches, inspect merge conflicts, and safely undo commits without destructive history rewriting:

```bash
preva git revert <commit>           # Pre-flight commit revert safety preview
preva git revert -n <commit>        # Invert changes into staging index without committing
preva git revert -m 1 <commit>      # Revert merge commit retaining specified mainline parent
preva git revert --continue         # Continue revert after resolving conflicts
preva git revert --abort            # Safe rewind to pre-revert state
preva git revert --skip             # Skip current revert step
preva git revert                    # Interactive commit selector from recent history
# or shorthand:
preva revert
```

- **Inverse Diff Safety Preview**: Inspects target commit metadata, author details, timestamps, and files to be inverted (displaying inverted diff statistics) before creating the revert commit.
- **Merge Commit Mainline Guard**: Detects when a target commit is a merge commit with multiple parents. Informs you and prompts for the mainline parent branch (`-m 1` or `-m 2`) instead of failing with Git's cryptic mainline error.
- **Conflict Pre-Check & Auto-Stash**: Analyzes target commit files against subsequent commits on the branch and working directory edits to flag potential merge conflicts before execution, with optional automatic auto-stashing of uncommitted edits.
- **Active Revert Recovery Hub**: When conflicts occur, Preva identifies unmerged files and provides one-click recovery options (`--continue`, `--skip`, `--abort`).

#### 19. Visual Remote Explorer & Health Dashboard (`preva git remote`)

Inspect configured remote endpoints, validate protocols, test reachability, and manage remotes safely without breaking branch tracking:

```bash
preva git remote                    # Visual remote explorer and management menu
preva git remote -v                 # Formatted remote table with fetch and push URLs
preva git remote add <name> <url>   # Add remote with protocol validation & collision check
preva git remote set-url <name> <url> # Update remote URL with diff preview
preva git remote rename <old> <new> # Rename remote and preview tracking branch updates
preva git remote prune <name>       # Preview and delete stale remote tracking branches
preva git remote remove <name>      # Safe removal with tracking branch guard
preva git remote show <name>        # Detailed breakdown and connection latency test
# or shorthand:
preva remote
```

- **Visual Remote Table**: Clean overview displaying remote names, protocol badges (`[HTTPS]`, `[SSH]`, `[FILE]`), and endpoints, with distinct styling for asymmetric fetch/push URLs.
- **Tracking Branch Safeguards**: Before renaming or removing a remote, Preva inspects and lists all local branches currently configured to track that remote to prevent orphaned tracking states.
- **Protocol & Typo Validation**: Validates URL format and catches common typo schemes (e.g. `htps://`, `gttps://`) with one-click suggestions before Git creates malformed configurations.
- **Interactive Remote Manager**: Run without arguments to inspect endpoints, test connectivity latency, add new remotes, update URLs, prune stale branches, or safely remove configurations.

#### 20. Repository Initialization Guard & Smart Gitignore (`preva git init`)

Initialize new Git repositories safely with default branch configuration, nested repository detection, and automatic security-focused `.gitignore` generation:

```bash
preva git init                      # Safe repository initialization in current folder
preva git init <directory>          # Initialize in specific directory
preva git init -b <branch>          # Set custom initial branch name (e.g. develop)
preva git init --bare               # Initialize bare repository
# or shorthand:
preva init
```

- **Pre-Init Directory & Collision Inspector**: Pre-checks target path before initialization. Detects if the folder is already a Git repository (preventing unintentional re-initializations) or located inside an existing parent Git repository (guarding against accidental nested repositories).
- **Smart `.gitignore` Shield**: If no `.gitignore` exists, Preva generates a tailored `.gitignore` combining universal security protections (blocking `.env*`, `*.key`, `*.pem`, `credentials.json`, `id_rsa*`, OS files) with detected framework rules (Node.js, Python, Rust, Go).
- **Default Main Branch**: Configures the initial branch to `main` out of the box without requiring manual `git branch -M main` workarounds.
- **Actionable Next Steps**: Prints clear next steps after initialization (`preva git add .`, `preva git commit`, `preva git remote add origin <url>`, `preva git push -u origin main`).

---

### What `preva` Flags

1. **Common Sensitive Patterns:** Identifies common credential and key formats by filename (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials.json`, `*.p12`, `*.keystore`, `*.p8`, `*.ovpn`, `.npmrc`, `.pypirc`).
2. **Tracked `.gitignore` Matches:** Flags files that match your project's `.gitignore` rules but are still being tracked because they were committed previously.
3. **Heavy Directories:** Highlights unignored directories such as `node_modules/` or `dist/` before they are staged.
4. **Renamed and Deleted Files:** Distinguishes renames (`R`) and deletions (`D`) in the checklist.

---

### Boundaries (What `preva` Is Not)

- **Not a Secret Scanner:** `preva` checks file names and paths against known patterns. It does not scan inside file contents for hardcoded tokens or API keys.
- **No Automatic History Alterations:** `preva` will never automatically rebase, reset, or amend commits for you.
- **No Native Git Interception:** It does not install Git hooks. Plain `git add` and `git push` will continue to run without `preva` unless explicitly invoked.

---

### Installation & Usage

Install globally via npm:

```bash
npm install -g preva-cli
```

Or run directly with `npx`:

```bash
npx preva-cli git add .
```

#### Commands

| Command | Description |
|---|---|
| `preva git add .` | Review all changes in an interactive checklist before staging |
| `preva git add <paths...>` | Review specific files or folders before staging |
| `preva git commit` | Interactive Conventional Commit generator with selectable types |
| `preva git push [remote] [branch]` | Review unpushed commits and files before pushing |
| `preva git pull [remote] [branch]` | Preview incoming commits, diffs, and conflict pre-check |
| `preva git merge [branch]` | Pre-merge commit, diff, and conflict inspector |
| `preva git rebase [branch]` | Pre-rebase commit and conflict inspector, auto-stash guard |
| `preva git log [args...]` | Visual commit history browser and commit inspector |
| `preva git cherry-pick [commit]` | Pre-cherry-pick commit preview and conflict safeguard |
| `preva git tag [args...]` | Visual tag browser, creator, and deletion guard |
| `preva git clone [url] [dir]` | Pre-clone review, collision guard, and tech detector |
| `preva git revert [commit]` | Pre-revert safety preview, merge guard, and recovery hub |
| `preva git remote [args...]` | Visual remote explorer, health dashboard, and guard |
| `preva git init [directory]` | Repository initialization guard and smart gitignore setup |
| `preva git branch [args...]` | Interactive branch manager and preview guard |
| `preva git stash [args...]` | Safe stash inspector and destructive drop guard |
| `preva git diff [args...]` | Interactive visual diff explorer and file inspector |
| `preva git status [args...]` | Repository health dashboard and smart action hub |
| `preva git restore [args...]` | Safe unstage (--staged) and discard preview guard |
| `preva git reset [args...]` | Safe commit unwrap (--soft) and reset guard |
| `preva git clean [args...]` | Untracked file deletion preview guard |
| `preva undo` | Interactive undo helper |
| `preva --version` | Show installed version |
| `preva --help` | Show usage help and options |

---

### Non-Interactive Environments & CI

When run in environments without an interactive TTY (`!process.stdin.isTTY`):
- `preva` detects the missing terminal and exits cleanly with code `1` rather than hanging.

| Exit Code | Meaning |
|---|---|
| `0` | Success: files staged or commits pushed |
| `1` | Error: not a git repo, no changes, or non-interactive terminal |
| `130` | Cancelled by user (`Ctrl+C` or chose `N`) |

---

### Design Philosophy

- **Zero External Dependencies:** Built entirely with Node.js standard library built-ins (`node:readline`, `node:child_process`, `node:fs`, `node:path`).
- **Zero Extra Config Files:** No `.prevaignore` dotfiles required. Works using built-in patterns and your project's `.gitignore`.
- **Defensive Execution:** Runs native Git commands using `execFile` with argument arrays and `--` path separators to avoid shell quoting and flag injection issues.

---

### License

MIT License © [gozajpeg](https://github.com/gozajpeg)
