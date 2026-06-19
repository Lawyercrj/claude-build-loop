import { describe, it, expect } from "vitest";
import { resolve } from "path";
import {
  matchDeletion,
  matchDestructiveGit,
  matchDangerousRedirect,
  pathIsInsideRepo,
} from "../src/safety";

// The build-loop repo root — a real directory on disk, used as a stand-in for
// the executor's target repo so containment checks resolve real paths.
const REPO_ROOT = resolve(__dirname, "..");

// A command is "blocked" if either pattern classifier matches it.
function isBlocked(command: string): boolean {
  return matchDeletion(command) !== null || matchDestructiveGit(command) !== null;
}

describe("Bash deletion / destructive-git patterns", () => {
  const DENIED: Array<[string, string]> = [
    ["rm a file", "rm x"],
    ["rm -rf", "rm -rf build/"],
    ["rmdir", "rmdir somedir"],
    ["unlink", "unlink foo"],
    ["git rm", "git rm tracked.ts"],
    ["find -delete", "find . -name '*.log' -delete"],
    ["truncate", "truncate -s 0 file.txt"],
    ["dd overwrite", "dd if=/dev/zero of=file.txt"],
    ["git clean -fd", "git clean -fd"],
    ["git stash", "git stash"],
    ["git checkout -- file", "git checkout -- src/x.ts"],
    ["git checkout branch", "git checkout main"],
    ["git switch", "git switch main"],
    ["git restore", "git restore src/x.ts"],
    ["force push (--force)", "git push --force origin feat"],
    ["force push (-f)", "git push -f origin feat"],
    ["hard reset", "git reset --hard HEAD~1"],
    ["rebase", "git rebase main"],
  ];

  for (const [label, command] of DENIED) {
    it(`DENIES: ${label}`, () => {
      expect(isBlocked(command)).toBe(true);
    });
  }

  const ALLOWED: Array<[string, string]> = [
    ["git commit", "git commit -m 'wip'"],
    ["git add a file", "git add src/x.ts"],
    ["npm test", "npm test"],
    ["npm run build", "npm run build"],
    ["the word perform", "echo perform the task"],
    ["the word format", "npm run format"],
    ["git status", "git status"],
    ["git push (no force)", "git push origin feat"],
    ["git log", "git log --oneline"],
  ];

  for (const [label, command] of ALLOWED) {
    it(`ALLOWS: ${label}`, () => {
      expect(isBlocked(command)).toBe(false);
    });
  }
});

describe("Dangerous output-redirection patterns", () => {
  const DENIED: Array<[string, string]> = [
    ["truncating > into file", "echo x > file.ts"],
    ["truncating > into source", "cat a > src/safety.ts"],
    ["fd 1> redirect", "printf x 1> out.txt"],
    ["&> redirect", "foo &> out.txt"],
    ["2> stderr into file", "cmd 2> out.txt"],
    ["no-space x>file form", "cmd>file.ts"],
  ];

  for (const [label, command] of DENIED) {
    it(`DENIES: ${label}`, () => {
      expect(matchDangerousRedirect(command)).not.toBeNull();
    });
  }

  const ALLOWED: Array<[string, string]> = [
    ["append >>", "echo x >> log.txt"],
    ["stderr->stdout dup", "cmd 2>&1"],
    ["discard to /dev/null", "cmd > /dev/null"],
    ["stderr to /dev/null", "cmd 2> /dev/null"],
    ["bare grep, no redirect", "grep foo bar"],
    ["git commit", "git commit -m 'wip'"],
    ["npm test", "npm test"],
  ];

  for (const [label, command] of ALLOWED) {
    it(`ALLOWS: ${label}`, () => {
      expect(matchDangerousRedirect(command)).toBeNull();
    });
  }
});

describe("Write/Edit path containment", () => {
  it("ALLOWS a relative path inside the target repo", () => {
    expect(pathIsInsideRepo(REPO_ROOT, "src/safety.ts")).toBe(true);
  });

  it("ALLOWS an absolute path inside the target repo", () => {
    expect(pathIsInsideRepo(REPO_ROOT, resolve(REPO_ROOT, "src/index.ts"))).toBe(true);
  });

  it("ALLOWS a not-yet-created file inside the target repo", () => {
    expect(pathIsInsideRepo(REPO_ROOT, "src/brand-new-file.ts")).toBe(true);
  });

  it("DENIES an absolute path outside the target repo", () => {
    expect(pathIsInsideRepo(REPO_ROOT, "/etc/passwd")).toBe(false);
  });

  it("DENIES a ../ traversal escape", () => {
    expect(pathIsInsideRepo(REPO_ROOT, "../escape.txt")).toBe(false);
  });

  it("DENIES a deep ../ traversal escape", () => {
    expect(pathIsInsideRepo(REPO_ROOT, "src/../../escape.txt")).toBe(false);
  });

  it("DENIES an empty path", () => {
    expect(pathIsInsideRepo(REPO_ROOT, "")).toBe(false);
  });
});
