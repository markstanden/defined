// lib/js-files.mts — the JS/TS extensions the gate can parse.
//
// One list shared by the eslint step, the purity step and .defined.json
// validation: a file the gate advertises as lintable is a file a purity policy
// may select, and no rule config may drift from that set.

/** Extensions the baked parsers handle, in house order. */
export const JS_TS_EXTENSIONS = [
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "mts",
    "cts",
    "tsx",
] as const;

/** True when the path's final extension is one the gate parses. */
export function hasJsTsExtension({ file }: { file: string }): boolean {
    const dot = file.lastIndexOf(".");
    if (dot === -1) {
        return false;
    }
    return (JS_TS_EXTENSIONS as readonly string[]).includes(
        file.slice(dot + 1),
    );
}

/** Keep only the files the gate can parse. */
export function filterJsTsFiles({ files }: { files: string[] }): string[] {
    return files.filter((file) => hasJsTsExtension({ file }));
}
