#!/usr/bin/env bash
set -Eeuo pipefail

host_workspace=${1:?WSL workspace path required}
host_archive=${2:?WSL result archive path required}
timeout_ms=${3:?timeout milliseconds required}
shift 3
timeout_seconds=$(awk -v milliseconds="$timeout_ms" 'BEGIN { printf "%.3fs", milliseconds / 1000 }')

sandbox=$(mktemp -d /tmp/kiln-benchmark-sandbox.XXXXXX)
trap 'rm -rf -- "$sandbox"' EXIT
mkdir -p "$sandbox/workspace" "$sandbox/home" "$sandbox/tmp"
cp -a "$host_workspace/." "$sandbox/workspace/"
chmod -R u+rwX "$sandbox"

set +e
timeout --signal=TERM --kill-after=2s "$timeout_seconds" \
  unshare --user --map-root-user --net --mount --pid --fork --mount-proc \
  env -i \
    HOME="$sandbox/home" \
    TMPDIR="$sandbox/tmp" \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    KILN_BENCHMARK_SANDBOX=offline-wsl-unshare \
    /bin/bash -c '/bin/mount -t tmpfs -o mode=0555 tmpfs /mnt; cd "$1"; shift; exec "$@"' sandbox "$sandbox/workspace" "$@"
agent_rc=$?
set -e

mkdir -p "$(dirname "$host_archive")"
tar -cf "$host_archive" -C "$sandbox/workspace" .
exit "$agent_rc"
