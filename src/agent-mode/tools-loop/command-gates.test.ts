import { describe, it, expect } from "vitest";
import { describeDestructive } from "./command-gates.js";

// Each of these loses data or cannot be undone, and ran without a confirm before: the destructive
// gate only knew rm, git reset --hard, git clean -f and git checkout --.
const MUST_CONFIRM: Array<[string, RegExp]> = [
  ["find . -name '*.log' -delete", /delete/],
  ["find dist -type f -delete && ls", /delete/],
  ["echo '' > src/index.ts", /overwrite/],
  ["cat > src/config.ts <<'EOF'\nexport {}\nEOF", /overwrite/],
  ["npm test 1> results.txt", /overwrite/],
  ["truncate -s 0 data.db", /truncate|empty/],
  ["dd if=/dev/zero of=disk.img bs=1M count=1", /overwrite/],
  ["shred -u secrets.txt", /delete|overwrite/],
  ["git push --force origin main", /force/],
  ["git push -f", /force/],
  ["git push --force-with-lease origin feat", /force/],
  ["git push origin +main", /force/],
  ["git branch -D feature/x", /branch/],
  ["git stash drop", /stash/],
  ["git stash clear", /stash/],
  ["git restore src/a.ts", /discard/],
  ["git checkout -f main", /discard/],
  ["git switch --discard-changes main", /discard/],
  ["npm publish", /publish/],
  ["pnpm publish --access public", /publish/],
  ["yarn npm publish", /publish/],
  ["docker rm -f web", /docker/],
  ["docker volume rm pgdata", /docker/],
  ["docker system prune -af", /docker/],
  ["docker compose down -v", /docker/],
  ["kubectl delete pod api-123", /kubernetes|kubectl/],
  ['psql -c "DROP TABLE users"', /SQL/],
  ["sqlite3 app.db 'delete from sessions'", /SQL/],
  ['mysql -e "TRUNCATE TABLE logs"', /SQL/],
];

// Everyday commands that must NOT prompt: a gate that fires on routine work gets switched off,
// and then protects nothing.
const MUST_NOT_CONFIRM = [
  "npx tsc --noEmit 2>&1",
  "npm test > /dev/null 2>&1",
  "npm run build >/dev/null",
  "npm test 2> /dev/null",
  "echo hi >&2",
  "npm test >> test.log",
  "node -e \"const f = (x) => x + 1\"",
  "grep -n 'a -> b' README.md",
  "find . -name '*.ts' -newer package.json",
  "git push origin main",
  "git branch -d merged-branch",
  "git branch --list",
  "git stash",
  "git stash pop",
  "git stash list",
  "git restore --staged src/a.ts",
  "git checkout main",
  "git switch main",
  "npm pack --dry-run",
  "npm run publish:docs-preview --dry-run --help",
  "docker ps -a",
  "docker compose down",
  "kubectl get pods",
  'psql -c "SELECT * FROM users"',
  "grep -rn 'DELETE FROM' src",
  "ls -la",
];

describe("describeDestructive — extended patterns", () => {
  for (const [cmd, why] of MUST_CONFIRM) {
    it(`confirms: ${cmd.split("\n")[0]}`, () => {
      const d = describeDestructive(cmd);
      expect(d).not.toBeNull();
      expect(d).toMatch(why);
    });
  }

  for (const cmd of MUST_NOT_CONFIRM) {
    it(`does not confirm: ${cmd}`, () => {
      expect(describeDestructive(cmd)).toBeNull();
    });
  }
});
