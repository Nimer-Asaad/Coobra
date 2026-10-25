# Git workflow

## Current state

The GitHub repository `Nimer-Asaad/Coobra` was created empty (no commits, no branches).
Phase 1 is developed on the branch `claude/wizardly-hamilton-g9c7gy`. Its first commit is the
root of the project history.

## Establishing `main` as the default branch (recommended)

Do this once, after the Phase 1 commit has been reviewed and pushed:

1. **Push the work branch** (no force):
   `git push -u origin claude/wizardly-hamilton-g9c7gy`
   Because the repository is empty, GitHub will make this first pushed branch the default
   branch temporarily.
2. **Create `main` from the reviewed commit** — same history, nothing rewritten:
   `git push origin claude/wizardly-hamilton-g9c7gy:refs/heads/main`
   (or on GitHub: _Branches → New branch → `main` from `claude/wizardly-hamilton-g9c7gy`_).
3. **Make `main` the default branch**: _Settings → General → Default branch → `main`_.
4. **Protect `main`**: _Settings → Branches/Rulesets_ — require pull requests, at least one
   approving review, passing status checks (once CI exists), linear history if preferred;
   block force pushes and deletions.
5. From then on, every phase is developed on its own branch created from `main` and merged
   through a pull request. Optionally delete the Phase 1 work branch after `main` exists.

This keeps a single, linear history: `main` simply points at the reviewed Phase 1 commit,
so there is no unrelated history and no force-push is ever required.

Alternative (if you prefer review through a PR from the very first commit): create `main`
from the first commit as above, then open PRs from feature branches into `main` for every
subsequent change.
