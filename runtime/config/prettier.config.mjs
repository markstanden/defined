// House Prettier config — travels inside runtime/config/, passed explicitly
// via --config so it applies regardless of CWD or target repo.
//
// Pure Prettier defaults. Indentation intentionally comes from the project
// .editorconfig instead: prettier reads it natively and gives it HIGHER
// priority than an explicit config (verified 2026-08-30 — an indent_size=2
// .editorconfig beats a tabWidth:4 config). Gate setup installs
// standards/.editorconfig into consumer roots, so one file drives prettier,
// shfmt and every EditorConfig-aware IDE in lockstep. Keep indent_size in
// .editorconfig and this file's defaults aligned — see PLAN decision.
/**
 * Prettier settings; the defaults are pure intentional. The indent that
 * matters travels in .editorconfig (see the header note above).
 *
 * @type {import("prettier").Config}
 */
export default {};
