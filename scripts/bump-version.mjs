/**
 * Bump the patch version, and stage it, as part of committing.
 *
 * The version is not ceremony here: `manifest.config.ts` emits it as the
 * extension's own `version`, so it is what chrome://extensions shows. That makes
 * it the answer to the question that costs the most time in this project — "is
 * the browser running the build I just made, or the one from an hour ago?" A
 * version that only moves at release time cannot answer it; one that moves every
 * commit can.
 *
 * Deliberately quiet about the cases where bumping would be wrong:
 *
 *  - **A merge, rebase or cherry-pick in progress.** The commit being made is
 *    not new work, and bumping mid-rebase rewrites the same line in every
 *    replayed commit, which is a conflict per commit.
 *  - **A version already staged by hand.** Deciding this release is 0.2.0 is a
 *    statement; turning it into 0.1.9 because a hook prefers patches is not a
 *    service.
 *  - `SKIP_BUMP=1`, for the commit that is only a fixup.
 *
 * The lockfile carries the same version twice and npm rewrites it on the next
 * install, so both copies move together rather than leaving a diff to trip over
 * later.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgPath = join(root, "package.json")
const lockPath = join(root, "package-lock.json")

function git(...args) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

function inProgress() {
    // `--absolute-git-dir` rather than `--git-dir`: the latter answers with a
    // relative path here and an absolute one inside a worktree, and joining an
    // absolute path onto the root silently produces neither.
    const gitDir = git("rev-parse", "--absolute-git-dir")
    return ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].some(marker =>
        existsSync(join(gitDir, marker))
    )
}

/** The version as HEAD has it, or null for the very first commit. */
function committedVersion() {
    try {
        return JSON.parse(git("show", "HEAD:package.json")).version ?? null
    } catch {
        return null
    }
}

if (process.env.SKIP_BUMP === "1") process.exit(0)
if (inProgress()) process.exit(0)

const source = readFileSync(pkgPath, "utf8")
const current = JSON.parse(source).version
const previous = committedVersion()

if (previous !== null && previous !== current) {
    console.log(`version already set to ${current} by hand — leaving it alone`)
    process.exit(0)
}

const parts = current.split(".")
if (parts.length < 3 || parts.some(part => !/^\d+$/.test(part))) {
    console.log(`version "${current}" is not plain numbers — leaving it alone`)
    process.exit(0)
}

parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1)
const next = parts.join(".")

// A targeted replacement, not a re-serialisation: rewriting the whole file would
// reformat and reorder it, turning a one-line bump into an unreadable diff.
writeFileSync(pkgPath, source.replace(`"version": "${current}"`, `"version": "${next}"`))

if (existsSync(lockPath)) {
    /*
     * Only the first two: the lockfile's own version and the root package's,
     * both at the top of the file. `replaceAll` would also rewrite any
     * dependency that happens to sit at the same version.
     */
    let left = 2
    const needle = new RegExp(`"version": "${current.replace(/\./g, "\\.")}"`, "g")
    const lock = readFileSync(lockPath, "utf8").replace(needle, match => (left-- > 0 ? `"version": "${next}"` : match))
    writeFileSync(lockPath, lock)
    git("add", "--", "package-lock.json")
}

git("add", "--", "package.json")
console.log(`version ${current} → ${next}`)
