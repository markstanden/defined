# Dependabot and the managed gate workflow

`comply` installs `.github/workflows/defined--verify.yml` and keeps it
byte-identical to the copy baked into the image (`standards/workflows/defined--verify.yml`).
It is **managed**: the gate restores it on every run and reports a hand-edit as
`differs from gate copy`, so its action pins move upstream with the gate and are
never bumped in the consumer repo.

Dependabot's `github-actions` ecosystem scans `.github/workflows/`, so it will
propose bumping a pin inside that managed file. Such a PR can never go green —
`comply` overwrites the file from the image and the change is reported as drift.
Exclude the managed file, and let Dependabot keep every repo-owned workflow
current:

```yaml
# .github/dependabot.yml
version: 2
updates:
    - package-ecosystem: github-actions
      directory: /
      exclude-patterns:
          - ".github/workflows/defined--verify.yml"
```

Managed pins are adopted the same way as the rest of the gate: bump the
`.defined.json` `version` to the new gate tag (or run `defined update`) and run
`comply`, which reinstalls the current managed copy.
