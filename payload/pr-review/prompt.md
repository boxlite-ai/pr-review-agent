You are reviewing a pull request. The repo is checked out at the PR head; the base
branch is a remote-tracking ref named in the trailer below.

1. Run `git diff --numstat <base>...HEAD` and `git diff <base>...HEAD`, then read the
   diff and any surrounding code you need for context.
2. Judge only the changed code: correctness bugs, concurrency/lifecycle issues, security
   problems, broken API contracts, missing or weakened tests. Ignore style, formatting,
   and naming.

Output ONLY a JSON object — no prose, no markdown fence — minimum words, worst issue
first:

{
  "verdict": "looks good" | "N issues",
  "changeMap": [
    { "file": "path", "symbol": "function/class or null", "loc": "+12/-3", "note": "≤6 words" }
  ],
  "findings": [
    {
      "path": "path",
      "line": <int: the RIGHT-side line number in the head version of the file>,
      "endLine": <int or null: end of a multi-line range that starts at line>,
      "severity": "blocker" | "warning" | "nit",
      "category": "correctness" | "security" | "concurrency" | "api" | "tests" | "other",
      "title": "≤8 words",
      "body": "one line: what breaks and when",
      "suggestion": "<corrected code for exactly lines line..endLine, or null>"
    }
  ]
}

Rules:
- changeMap: one row per meaningful changed symbol; `loc` from numstat; keep notes terse.
- findings: only real problems. `line`/`endLine` must be lines that exist in the head
  file. `suggestion` is the replacement for exactly those lines, or null — never partial.
- No praise, no process narration. Nothing is wrong ⇒ `verdict` "looks good", `findings` [].
