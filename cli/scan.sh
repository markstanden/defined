#!/usr/bin/env bash
# cli/scan.sh — install-less entry point: cached launcher + `scan`.
#
# Run it straight from the published repository:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/markstanden/defined/main/cli/scan.sh)
#
# It downloads cli/defined from the published main branch, verifies it against
# the sha256 constant below (the launcher and this script are a matched pair
# committed together), caches it under ${XDG_CACHE_HOME:-$HOME/.cache}/defined,
# then execs `scan`. The cache entry is named by the launcher's content hash, so
# a newer script never trusts an older cached launcher; `--refresh` re-fetches.
# Every other argument is forwarded untouched — `--min`/`--full`/`--timings`
# belong to the gate, which validates them itself.
#
# `scan` never installs and never adopts: it runs the gate's lint/scan steps
# read-only and reports one JSON line. A `.defined.json` (committed or
# locally ignored) is honoured when present. Needs bash, curl or wget, and the
# usual coreutils; no git and no global installation.

set -euo pipefail

# The sha256 of cli/defined as committed alongside this file. A launcher edit
# must update this constant in the same commit; cli/scan.test.mts fails the
# gate if the two drift apart.
LAUNCHER_SHA256="86d2bdc18061a50a655e69ad684a96e65eca79134fe405a25cb30167315bf9bf"

# The public repository, used for the launcher download.
LAUNCHER_URL="https://raw.githubusercontent.com/markstanden/defined/main/cli/defined"

CACHE_DIR="${XDG_CACHE_HOME:-${HOME}/.cache}/defined"

# Published name, independent of the invocation path: the documented one-liner
# runs this file from /dev/fd via process substitution, where a basename would
# be the descriptor number.
PROGRAM="scan.sh"

usage() {
    echo "usage: ${PROGRAM} [--refresh] [--min|--full] [--timings]" >&2
    return 0
}

die() {
    echo "${PROGRAM}: $*" >&2
    exit 1
}

# Download a URL to a file, preferring curl and falling back to wget.
download() {
    local url="$1" dest="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL -o "${dest}" "${url}"
        return 0
    fi
    if command -v wget >/dev/null 2>&1; then
        wget -q -O "${dest}" "${url}"
        return 0
    fi
    die "neither curl nor wget is available to download ${url}"
}

# This script owns only `--refresh` and `--help`; every other argument belongs
# to `scan`, so flag validation stays in one place (the gate's own parser).
refresh=""
args=()
for arg in "$@"; do
    case "${arg}" in
    --refresh)
        refresh=1
        ;;
    -h | --help)
        usage
        exit 0
        ;;
    *)
        args+=("${arg}")
        ;;
    esac
done

mkdir -p "${CACHE_DIR}"

# Content-keyed cache: a new scan.sh (new launcher checksum) can never reuse a
# stale launcher, so the cached copy always supports the verb this script runs.
launcher="${CACHE_DIR}/launcher-${LAUNCHER_SHA256:0:12}"
if [[ -n "${refresh}" || ! -f "${launcher}" ]]; then
    tmp="$(mktemp "${CACHE_DIR}/.launcher.XXXXXX")"
    trap 'rm -f "${tmp}"' EXIT
    download "${LAUNCHER_URL}" "${tmp}"
    actual="$(sha256sum "${tmp}")"
    actual="${actual%% *}"
    if [[ "${actual}" != "${LAUNCHER_SHA256}" ]]; then
        die "checksum mismatch for the launcher (expected ${LAUNCHER_SHA256}, got ${actual}) — the published script may have moved on; re-run this one-liner"
    fi
    chmod 755 "${tmp}"
    mv "${tmp}" "${launcher}"
fi

exec bash "${launcher}" scan "${args[@]}"
