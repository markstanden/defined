---
Area: decisions
Keywords: tool pins, shellcheck, shfmt, yamllint, checksum, supply chain, apt ceiling, multi-arch
Summary: Why shellcheck and shfmt install from upstream release assets instead of the Debian feed, how every image download is now checksum-verified, and yamllint's documented ceiling.
---

# Tool pins come from upstream assets, checksum-verified

The image's shell tools used to be apt packages while `runtime/Containerfile`
asserted their exact versions, so Debian's feed was the ceiling on two pins. The
five release downloads beside them were pinned by version but never by bytes.
Both problems are fixed the same way: fetch the asset, verify a pinned sha256,
and only then unpack it into PATH.

## Facts

- Debian 13 (trixie), the base image's feed, carries shellcheck `0.10.0-1`,
  shfmt `3.8.0-1+b8` and yamllint `1.37.1-1`; upstream ships 0.11.0, 3.14.1 and
  1.38.0 (`apt-cache policy` inside `node:26.13.1-slim`, 2026-11-15).
- The base image has neither `python3` nor `xz` (`command -v` → not found), so a
  pip yamllint needs a new toolchain and a `.tar.xz` shellcheck needs a package.
- shellcheck, shfmt and zizmor publish no checksum asset — their release pages
  list only binaries and source archives. actionlint, gitleaks, opentofu and
  tflint do, and those pins are copied from the published files.
- `/bin/sh` in the image is dash, which rejects `${!var}` with
  `Bad substitution`, so the per-arch hash is aliased in the `case` block rather
  than selected indirectly.
- Upstream shfmt 3.14.1 prints `v3.14.1`, while Debian's 3.8.0 build printed
  bare `3.8.0`. The assert strips a leading `v`; the first build after the
  switch failed exactly there (`test v3.14.1 = 3.14.1`).

## Decisions

- shellcheck and shfmt install from upstream release assets like the Go tools,
  and keep their exact-version assert: the assert is what catches an upstream
  asset-naming change.
- Every download lands in `/tmp`, is checked with `sha256sum -c`, and only then
  is unpacked or `install`ed into PATH. A mismatch fails the build.
- Where upstream publishes a checksum, the pin is that value; otherwise it is a
  hand pin in `runtime/tool-versions.env`, with its derivation dated in the
  comment. A bump means re-deriving it deliberately, never copying a third-party
  hash.
- yamllint stays on apt: 1.38.0 would cost python3 + pip (~100 MB) for a point
  release. Its ceiling is recorded beside the pin so the next reader does not
  "fix" it by unpinning.
- shellcheck uses the `.tar.gz` asset rather than `.tar.xz`: same release
  content, no `xz-utils` added to the image.

## Tested

- `runtime/containerfile.test.mts` proves every GitHub download has a pin for
  both arches, is verified before use, and that no build path references
  `api.github.com` or `releases/latest`.
- All seven assets were fetched for amd64 and arm64 and matched their pins; the
  four published checksum files verified with `sha256sum -c` (2026-11-15).
- Churn probe over 123 tracked `*.sh` files in four gated checkouts: shfmt
  3.8.0 → 3.14.1 reformats 0 files; shellcheck 0.10.0 → 0.11.0 adds 0 findings
  at floor `style`.
- Corrupting one character of `SHELLCHECK_SHA256_AMD64` failed the build at the
  verify step (`/tmp/shellcheck.tar.gz: FAILED`, `1 computed checksum did NOT
match`, build exit 1); the pin was restored immediately.

## Inferred

- The arm64 pins are derived from arm64 asset bytes on an amd64 host. sha256 is
  architecture-independent, so the pins are sound, but nothing local executes
  the arm64 binaries — only the multi-arch publish does.
- Zero churn on four checkouts is not a promise for every consumer; it is the
  measured sample.

## Open questions

- Refresh these pins on a schedule, or by hand when a feature or fix is wanted?
  Nothing is scheduled today.
- Should the Microsoft apt bootstrap deb be pinned too? It is a rolling asset and
  apt verifies the packages it enables by signature; left unpinned deliberately.
