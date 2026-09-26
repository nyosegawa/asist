#!/bin/sh
# Runs the tests a branch added or changed against the source of its base, to show that each test fails
# without the fix. It checks the base out in a temporary worktree, puts the branch's version of every
# added or changed file under tests/ into it, runs those test files, prints the failures and removes the
# worktree. A test file that cannot even load on the base, because it imports something the branch added,
# is listed as a failed file.
# Usage: sh skills/worktree-delegation/scripts/tests-on-base.sh <branch> [base]
set -eu

if [ $# -lt 1 ]; then
  echo "使い方: tests-on-base.sh <ブランチ> [基にするコミット]" >&2
  exit 2
fi
branch=$1
base=${2:-origin/main}

common=$(git rev-parse --path-format=absolute --git-common-dir)
root=$(dirname "$common")
dir="$root/.claude/worktrees/tests-on-base-$$"
list=$(mktemp)
cleanup() {
  git -C "$root" worktree remove --force --force "$dir" 2>/dev/null || true
  rm -f "$list"
}
trap cleanup EXIT INT TERM

git -C "$root" diff --name-only --diff-filter=AM "$base...$branch" -- tests/ > "$list"
if [ ! -s "$list" ]; then
  echo "$branch は tests/ の下を何も足しても変えてもいません" >&2
  exit 1
fi

git -C "$root" worktree add -q --detach "$dir" "$(git -C "$root" merge-base "$base" "$branch")"
for dep in node_modules resources/git resources/uv; do
  if [ -e "$root/$dep" ]; then cp -cR "$root/$dep" "$dir/$dep"; fi
done
while IFS= read -r file; do
  mkdir -p "$dir/$(dirname "$file")"
  git -C "$root" show "$branch:$file" > "$dir/$file"
done < "$list"

tests=$(grep -E '\.test\.tsx?$' "$list" | tr '\n' ' ')
echo "基にしたコミット: $(git -C "$root" rev-parse --short "$base")、流すテスト: $tests"
# The run is expected to fail, so its exit code is not this script's.
(cd "$dir" && npx vitest run $tests 2>&1 || true) | grep -E '^ (FAIL|✓|×)| Test Files | Tests ' || true
