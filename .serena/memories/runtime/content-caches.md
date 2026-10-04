# runtime — content-caches

Keywords: content cache, per-file cache, FileCache, partitionByHash, identityHash, hashFile, prettier, eslint, node step, verifyEslint, DEFINED_CACHE_DIR, named volume, read-only verify, timings, cache metrics, issue 68
What: how the gate reuses per-file prettier/eslint verdicts across iterations (#68) — identity = tool versions + house config + ignore/editorconfig + .defined.json overrides; cache lives on a pin+repo named volume outside the read-only checkout; hits report under --timings → docs/runtime/content-caches.md
