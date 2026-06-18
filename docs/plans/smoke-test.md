---
name: smoke-test
branch: chore/build-loop-smoke-test
steps:
  - id: step-1
    description: create the test file
    instruction: |
      You are the executor in an automated build loop.

      You are already running inside the target repository (the loop set your
      working directory to it). Perform exactly these actions on the
      chore/build-loop-smoke-test branch (it already exists — check it out if
      needed, do NOT create a new branch):

      1. Run: git checkout chore/build-loop-smoke-test
      2. Create a file named PHASE_B_REVIEW_TEST.md at the repo root containing
         exactly this one line (no trailing blank line, no other content):
         Reviewed by the build loop.
      3. Commit ONLY that file (never git add -A or git add .):
         git add PHASE_B_REVIEW_TEST.md
         git commit -m "build-loop step: create PHASE_B_REVIEW_TEST.md"
      4. Do NOT push. Do NOT touch any other file.
      5. Print a short confirmation of what you did.
---

# Smoke Test — One Step

Step 1: Create a new file named PHASE_B_REVIEW_TEST.md at the repo root containing exactly one line: Reviewed by the build loop.
