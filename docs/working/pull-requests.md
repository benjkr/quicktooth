# Commits, pull requests, merges and releases

Read before committing, branching, opening or updating a PR, merging, tagging, or posting on GitHub.

## Branches and commits

- Every change, docs included, is made on its own named branch (`t3/<topic>`), never on `main`.
  Never push to `main` unless the user asks in that request; an earlier yes doesn't carry over.
- Commit finished work, with a message that says what changed and why, plus the harness's
  attribution trailer.

## Pull requests

- "Make PR" means: push the branch, open the PR from `.github/pull_request_template.md`, and link it
  in T3 (`link_pull_request`).
- The description shows the latest state: after a push that changes what the PR does or looks
  like, rewrite it and update its media. Visible changes carry simulator media (a GIF or stills,
  before/after when it replaces something).
- Stacked PRs: base each on the branch below it. After the lower one merges, retarget the next
  (`gh pr edit <n> --base main`), check it's mergeable, then merge.
- A comment posted on GitHub by an agent goes out under the user's account, so it starts by saying
  it's Claude, commenting on their behalf.

## Merging

- Only when the user asks. Use merge commits, one PR at a time, in stack order. Then fast-forward
  the local `main`.
- After merging, nothing gets installed automatically. The user's PC runs only `main`, from a tag
  once releases are tagged ([build and install](../specs/build-and-install.md)).

## Releases (when the user wants one)

- Bump `<Version>` in `src/QuickTooth/QuickTooth.csproj`, tag `main` (`vX.Y.Z`) and build the
  installer from the tag.
- Before anything public: the icon credit in the README, and a note that the installer is unsigned
  (SmartScreen).
