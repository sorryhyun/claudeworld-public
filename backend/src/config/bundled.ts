/**
 * What shape the process is running in: a `bun run` from the repository, or the
 * single-file executable `bun build --compile` produces.
 *
 * `scripts/build/exe-bundle.ts` bakes both constants in with `--define`. A repo
 * run never defines them, and the `typeof` guard is what makes that a plain
 * `false` instead of a ReferenceError — `--define` substitutes the identifier
 * textually, so there is no binding to fall back on.
 */

declare const __CLAUDEWORLD_BUNDLED: boolean | undefined
declare const __CLAUDEWORLD_VERSION: string | undefined

/**
 * True only inside the compiled binary. Every "the repository is not there"
 * branch keys off this one constant rather than sniffing `process.execPath` or
 * `Bun.embeddedFiles`, so a test can reason about which branch it is on.
 */
export const IS_BUNDLED_EXE: boolean =
  typeof __CLAUDEWORLD_BUNDLED !== 'undefined' && __CLAUDEWORLD_BUNDLED === true

/**
 * Release the binary was cut from, or `null` outside it. The exe has no
 * `package.json` beside it to read — its project root is whatever directory the
 * user dropped it in — so the version has to be compiled in.
 */
export const BUNDLED_VERSION: string | null =
  typeof __CLAUDEWORLD_VERSION !== 'undefined' && __CLAUDEWORLD_VERSION
    ? __CLAUDEWORLD_VERSION
    : null
