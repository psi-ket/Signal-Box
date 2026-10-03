/**
 * Lists or removes everything Colab created in a repository: session worktrees under
 * .git/colab/worktrees, colab/* branches, and refs/colab/* snapshot refs.
 * Dry run by default.
 *   npm run cleanup -- --repo <path>            # show what would be removed
 *   npm run cleanup -- --repo <path> --yes      # remove (uncommitted work in worktrees is lost)
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { git, gitOut, inspectRepo } from "../server/git.ts";

async function main() {
  const { values } = parseArgs({ options: { repo: { type: "string" }, yes: { type: "boolean" } } });
  if (!values.repo) throw new Error("pass --repo <path>");
  const repo = await inspectRepo(values.repo);
  const wtRoot = path.join(repo.commonDir, "colab", "worktrees");
  const list = await gitOut(["worktree", "list", "--porcelain"], repo.root);
  const worktrees = list
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => path.resolve(l.slice(9)))
    .filter((p) => p.toLowerCase().startsWith(wtRoot.toLowerCase()));
  const branches = (await gitOut(["for-each-ref", "--format=%(refname:short)", "refs/heads/colab/"], repo.root)).split("\n").filter(Boolean);
  const refs = (await gitOut(["for-each-ref", "--format=%(refname)", "refs/colab/"], repo.root)).split("\n").filter(Boolean);

  console.log(`Repo: ${repo.root}`);
  console.log(`Worktrees (${worktrees.length}):\n  ${worktrees.join("\n  ") || "-"}`);
  console.log(`Branches (${branches.length}):\n  ${branches.join("\n  ") || "-"}`);
  console.log(`Snapshot refs (${refs.length})`);
  if (!values.yes) {
    console.log("\nDry run. Re-run with --yes to remove these. Uncommitted work in the worktrees will be lost.");
    return;
  }
  for (const w of worktrees) await git(["worktree", "remove", "--force", w], { cwd: repo.root });
  await git(["worktree", "prune"], { cwd: repo.root });
  for (const b of branches) await git(["branch", "-D", b], { cwd: repo.root });
  for (const r of refs) await git(["update-ref", "-d", r], { cwd: repo.root });
  console.log("Removed.");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
