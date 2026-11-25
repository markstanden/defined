#!/usr/bin/env bash
# Defined runtime shim — the internal source-development surface.
#
# Locates a container engine, ensures the pinned image exists (builds it on
# first run or when tool pins change), mounts the target repo rw and
# runtime/ + lib/ + standards/ ro, then execs comply.mts inside the container.
#
# Usage: ./runtime/comply.sh            # local/agent loop (default): bootstrap + repair + verify
#        ./runtime/comply.sh --check-only  # read-only no-fix pass (tests + no-write checks)
#        ./runtime/comply.sh scan          # read-only no-fix pass, no bootstrap check (never adopts)
#
# `comply` is the always-use default; `--check-only` is the pipeline-style
# read-only pass, kept for the fixture tests and local no-write checks; `scan`
# is the install-less verb (same no-fix pass, bootstrap check skipped). The
# installed `defined` launcher is the public surface; this shim is gate
# development only.
#
# Engine preference is podman → docker: podman adheres more strictly to OCI
# semantics, so developing against it keeps the image honest; docker's
# leniency means anything that runs here runs there too.

set -euo pipefail

# Map the default verb and the read-only/scan verbs to the runtime contract.
# `explain` passes through with its topic as the remaining argument.
VERB="comply"
if [[ "${1:-}" == "--check-only" ]]; then
    VERB="verify"
    shift
elif [[ "${1:-}" == "explain" ]]; then
    VERB="explain"
    shift
elif [[ "${1:-}" == "scan" ]]; then
    VERB="scan"
    shift
fi

RUNTIME_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
GATE_ROOT="$(dirname "${RUNTIME_DIR}")"
LIB_DIR="${GATE_ROOT}/lib"
STANDARDS_DIR="${GATE_ROOT}/standards"

# Repo root comes from the invocation CWD's git root — never from where this
# script lives — so the gate can run against any checkout.
REPO_ROOT="$(git -C "${PWD}" rev-parse --show-toplevel)" || {
    # The report contract is one JSON line on stdout, and a caller reading the
    # pipe must be able to tell "could not run" from an empty run. The human
    # message stays on stderr.
    echo '{"status":"error","errors":[{"check":"git","kind":"execution","message":"not inside a git repository (run from within the target project)"}]}'
    echo "ERROR: not inside a git repository (run from within the target project)" >&2
    exit 1
}

# Repo identity for named shadow volumes (decision #3): dependencies are
# restored *inside* the container so host↔image ABI mismatches (e.g. Arch-built
# native modules) never leak in. Volumes are keyed by this hash so two checkouts
# of the same repo share one restore cache.
REPO_HASH="$(printf '%s' "${REPO_ROOT}" | sha256sum | cut -c1-12)"

if command -v podman >/dev/null 2>&1; then
    ENGINE="podman"
elif command -v docker >/dev/null 2>&1; then
    ENGINE="docker"
else
    echo "ERROR: no container engine found. Install podman or docker:" >&2
    echo "  see runtime/Containerfile for the supported base" >&2
    exit 1
fi

PINHASH="$(sha256sum "${RUNTIME_DIR}/tool-versions.env" | cut -c1-12)"
IMAGE="localhost/defined:${PINHASH}"

# Base image pins come from tool-versions.env — the single source of truth —
# and are injected as build args because FROM needs them before COPY.
# shellcheck source=runtime/tool-versions.env
source "${RUNTIME_DIR}/tool-versions.env"

if ! "${ENGINE}" image inspect "${IMAGE}" >/dev/null 2>&1; then
    echo "Building ${IMAGE} ..." >&2
    "${ENGINE}" build \
        -f "${RUNTIME_DIR}/Containerfile" \
        --build-arg "NODE_IMAGE_TAG=${NODE_IMAGE_TAG}" \
        --build-arg "NODE_IMAGE_DIGEST=${NODE_IMAGE_DIGEST}" \
        -t "${IMAGE}" "${GATE_ROOT}"
fi

# The image runs as non-root (uid 1000); map the invoking host user onto that
# uid so the mounted repo and the cache volumes stay writable. podman maps the
# host user to uid 1000 via --userns=keep-id; docker (rootful) runs the
# container as the host uid via --user. Either way the host user owns
# everything the gate writes, and no root is ever needed.
if [[ "${ENGINE}" == "podman" ]]; then
    USER_ARGS=("--userns=keep-id:uid=1000,gid=1000")
else
    USER_ARGS=(--user "$(id -u):$(id -g)")
fi

# Podman and docker create a nested volume's mount point *inside* the
# bind-mounted repo, as the namespace root: rootless podman lands it as
# 100000:100000, a path the invoking user cannot write afterwards. Create it
# here as the invoking user, and drop it again when the run leaves it empty.
# cli/defined carries the same logic for the launcher; comply-sh.test.mts holds
# this file's copy honest.
DEPS_DIR="${REPO_ROOT}/node_modules"
DEPS_ARGS=()
MADE_DEPS_DIR=""
if [[ "${VERB}" != "explain" ]]; then
    DEPS_ARGS=(-v "defined-node-${PINHASH}-${REPO_HASH}:/repo/node_modules")
    if [[ ! -e "${DEPS_DIR}" ]]; then
        if mkdir -p "${DEPS_DIR}"; then
            MADE_DEPS_DIR=1
        fi
    elif [[ ! -w "${DEPS_DIR}" ]]; then
        # Left by an earlier container run: only root could chown it, so name the
        # one-off fix rather than failing the gate over it.
        echo "WARNING: ${DEPS_DIR} is not writable by you — a host install there will fail; clear it once with: rmdir ${DEPS_DIR}" >&2
    fi
fi

# Not exec: an empty mount point is removed whichever way the run ends, and the
# gate's status is the shim's status.
STATUS=0
"${ENGINE}" run --rm \
    "${USER_ARGS[@]}" \
    -v "${REPO_ROOT}:/repo" \
    -v "${RUNTIME_DIR}:/opt/defined/runtime:ro" \
    -v "${LIB_DIR}:/opt/defined/lib:ro" \
    -v "${STANDARDS_DIR}:/opt/defined/standards:ro" \
    "${DEPS_ARGS[@]}" \
    -v "defined-npm-${REPO_HASH}:/home/node/.npm" \
    -v "defined-nuget-${REPO_HASH}:/home/node/.nuget/packages" \
    -v "defined-cache-${PINHASH}-${REPO_HASH}:/home/node/.cache/defined" \
    -e "NUGET_PACKAGES=/home/node/.nuget/packages" \
    --workdir /repo \
    "${IMAGE}" "${VERB}" "$@" || STATUS=$?

if [[ -n "${MADE_DEPS_DIR}" ]]; then
    rmdir "${DEPS_DIR}" 2>/dev/null || true
fi
exit "${STATUS}"
