#!/usr/bin/env bash
# cli/install.sh — install the defined host launcher (~/.local/bin/defined).
#
# This is the documented first-install path and the engine behind
# `defined update`: `defined update` fetches this file at the target revision
# and runs it with --rev. It is deliberately plain — every step commented, no
# clever one-liners, no hidden state.
#
# What it does, in order:
#   1. resolve the revision to install (--rev, DEFINED_REV, the checkout HEAD,
#      or the latest commit on main);
#   2. find the launcher source — the sibling cli/defined when running from a
#      matching checkout, otherwise download it at that revision;
#   3. verify its sha256 against the constant below: the launcher and this
#      installer are a matched pair committed together, so a mismatch means a
#      dirty checkout, a truncated download, or mismatched revisions;
#   4. substitute the revision into the launcher and install it atomically.
#
# It is idempotent: re-running with the same revision rewrites nothing.
#
# Environment:
#   DEFINED_BIN_DIR  install directory (default ~/.local/bin)
#   DEFINED_REV      revision to install when --rev is not given
#
# Needs git (for revision resolution) plus curl or wget (for the download
# path).

set -euo pipefail

# The sha256 of cli/defined as committed alongside this file. A launcher edit
# must update this constant in the same commit; cli/install.test.mts fails the
# gate if the two drift apart. The constant is the installed-byte guarantee:
# only the launcher committed with this installer is ever written.
LAUNCHER_SHA256="d1b9eaeeee55ea0f9a1f079f2f7122a171efaebdfc4ffcf5fd347e9565722623"

# The public repository, used for revision resolution and downloads.
REPO_SLUG="markstanden/defined"
REPO_URL="https://github.com/${REPO_SLUG}.git"
RAW_BASE="https://raw.githubusercontent.com/${REPO_SLUG}"

PROGRAM="$(basename "${BASH_SOURCE[0]}")"

# Scratch space for the fetched/rendered launcher; removed on exit. Declared
# here so the EXIT trap can name it without expanding at trap-set time.
WORK_DIR=""

usage() {
    echo "usage: ${PROGRAM} [--rev <sha>]" >&2
    return 0
}

die() {
    echo "${PROGRAM}: $*" >&2
    exit 1
}

# A revision is only ever a hex SHA: it is written into the launcher with sed
# and appended to a URL, so anything else is rejected before it is used.
validate_rev() {
    local rev="$1"
    if [[ ! "${rev}" =~ ^[0-9a-f]{7,40}$ ]]; then
        die "invalid revision '${rev}' — expected a 7–40 character hex SHA"
    fi
    return 0
}

# Resolve the revision to install, in precedence order:
#   --rev <sha>  explicit choice (also how `defined update` calls this script);
#   DEFINED_REV  environment override;
#   HEAD         when running from a defined checkout;
#   main         the latest commit, resolved over the network.
resolve_rev() {
    local explicit="$1"
    local checkout="$2"
    if [[ -n "${explicit}" ]]; then
        echo "${explicit}"
        return 0
    fi
    if [[ -n "${DEFINED_REV:-}" ]]; then
        echo "${DEFINED_REV}"
        return 0
    fi
    if [[ -n "${checkout}" ]]; then
        git -C "${checkout}" rev-parse HEAD
        return 0
    fi
    local remote
    remote="$(git ls-remote --refs "${REPO_URL}" refs/heads/main 2>/dev/null)" ||
        true
    remote="${remote%%[[:space:]]*}"
    if [[ -z "${remote}" ]]; then
        die "cannot resolve a revision — pass --rev <sha>, or check your network"
    fi
    echo "${remote}"
    return 0
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

# Place the launcher source at dest: the checkout's own copy when it has one,
# otherwise the published file at the resolved revision.
fetch_launcher() {
    local rev="$1" checkout="$2" dest="$3"
    if [[ -n "${checkout}" && -f "${checkout}/cli/defined" ]]; then
        cp "${checkout}/cli/defined" "${dest}"
        return 0
    fi
    download "${RAW_BASE}/${rev}/cli/defined" "${dest}"
}

# Fail loudly unless the fetched launcher is byte-for-byte the one committed
# with this installer.
verify_checksum() {
    local file="$1"
    local actual
    actual="$(sha256sum "${file}")"
    actual="${actual%% *}"
    if [[ "${actual}" != "${LAUNCHER_SHA256}" ]]; then
        die "checksum mismatch for ${file}: expected ${LAUNCHER_SHA256}, got ${actual}"
    fi
    return 0
}

# Bake the revision into the launcher's LAUNCHER_REV slot so the installed copy
# can report where it came from.
render_launcher() {
    local source="$1" rev="$2" dest="$3"
    sed "s|^LAUNCHER_REV=\"\"$|LAUNCHER_REV=\"${rev}\"|" "${source}" >"${dest}"
    if ! grep -q "^LAUNCHER_REV=\"${rev}\"$" "${dest}"; then
        die "could not bake the revision into the launcher (slot missing?)"
    fi
    return 0
}

# Install atomically: write a sibling temp file, chmod it, then move it into
# place. Re-running with identical content is a no-op.
install_launcher() {
    local rendered="$1" target="$2" short="$3"
    local dir
    dir="$(dirname "${target}")"
    mkdir -p "${dir}"
    if [[ -f "${target}" ]] && cmp -s "${rendered}" "${target}"; then
        echo "launcher already current: ${target} (rev ${short})"
        return 0
    fi
    local tmp
    tmp="$(mktemp "${dir}/.defined.XXXXXX")"
    cp "${rendered}" "${tmp}"
    chmod 755 "${tmp}"
    mv "${tmp}" "${target}"
    echo "installed launcher: ${target} (rev ${short})"
    return 0
}

# Point out the classic first-install trap: a bin dir that is not on PATH.
warn_path() {
    local dir="$1"
    case ":${PATH}:" in
    *":${dir}:"*) return 0 ;;
    esac
    echo "note: ${dir} is not on PATH — add it to your shell profile" >&2
    return 0
}

main() {
    local explicit_rev=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
        --rev)
            [[ $# -ge 2 ]] || die "--rev requires a value"
            explicit_rev="$2"
            shift 2
            ;;
        --rev=*)
            explicit_rev="${1#--rev=}"
            shift
            ;;
        -h | --help)
            usage
            return 0
            ;;
        *)
            usage
            return 2
            ;;
        esac
    done

    # Running from a checkout means the sibling launcher is the source and the
    # checkout HEAD is the natural revision. A downloaded installer has
    # neither, so it falls back to the network.
    local script_dir gate_root checkout
    script_dir="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
    gate_root="$(dirname "${script_dir}")"
    checkout=""
    if git -C "${script_dir}" rev-parse --show-toplevel >/dev/null 2>&1 &&
        [[ -f "${gate_root}/cli/defined" ]]; then
        checkout="${gate_root}"
    fi

    local rev bin_dir target
    rev="$(resolve_rev "${explicit_rev}" "${checkout}")"
    validate_rev "${rev}"
    bin_dir="${DEFINED_BIN_DIR:-${HOME}/.local/bin}"
    target="${bin_dir}/defined"
    WORK_DIR="$(mktemp -d)"
    trap 'rm -rf "${WORK_DIR}"' EXIT

    fetch_launcher "${rev}" "${checkout}" "${WORK_DIR}/defined"
    verify_checksum "${WORK_DIR}/defined"
    render_launcher "${WORK_DIR}/defined" "${rev}" "${WORK_DIR}/defined.installed"
    install_launcher "${WORK_DIR}/defined.installed" "${target}" "${rev:0:7}"
    warn_path "${bin_dir}"
    return 0
}

main "$@"
