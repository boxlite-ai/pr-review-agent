You are reviewing a pull request. The repo is checked out at the PR head; the base
branch is available as a remote-tracking ref (named in the trailer below).

1. Run `git diff --stat <base>...HEAD`, then read the full diff and any surrounding
   code you need for context.
2. Judge only the changed code. Look for: correctness bugs, concurrency/lifecycle
   issues, security problems, broken API contracts, missing or weakened tests.
   Ignore style, formatting, and naming.

Output exactly this, nothing else:
- one line: verdict (`looks good` or `N issues`)
- per issue: `path:line` — what breaks and when, then a one-line suggested fix; worst first
- no padding, no praise, no process narration
