#!/usr/bin/env bash
set -Eeuo pipefail

workspace=/workspace
project="$workspace/project"
benchmark_source="$workspace/benchmark"
benchmark=/opt/kiln-benchmark
state=/opt/kiln-ms4
dependencies=/opt/kiln-node-modules
results="$workspace/results/ms4-pilot-20261022"
rm -rf "$benchmark" "$state" "$dependencies"
mkdir -p "$benchmark" "$state"
cp -a "$benchmark_source/." "$benchmark/"
mkdir -p "$state" "$results/logs" "$results/config" "$workspace/models"
chmod 0700 "$state" "$benchmark" "$project"

"$project/runpod/bootstrap-research.sh"
ln -sfn "$workspace/pi/node_modules/.bin/pi" "$workspace/bin/pi"
node "$benchmark/scripts/ms4/patch-pi-fetch.mjs"
dnf -y install iproute procps-ng shadow-utils util-linux curl git >/dev/null
install -m 0755 "$benchmark/scripts/ms4/socket-relay.py" /usr/local/libexec/kiln-socket-relay.py
install -m 0755 "$benchmark/scripts/ms4/seccomp-exec.py" /usr/local/libexec/kiln-seccomp-exec.py
install -m 0644 "$benchmark/scripts/ms4/node-unix-fetch.cjs" /usr/local/libexec/kiln-node-unix-fetch.cjs

"$workspace/venvs/vllm/bin/python" - <<'PY'
import concurrent.futures
from huggingface_hub import snapshot_download

models = [
    ("Qwen/Qwen3.8-27B", "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0", "/workspace/models/qwen"),
    ("meta-models/Muse-Glimmer-30B", "cec94fcfd6512f2cfe708138c32533b346ea4f69", "/workspace/models/muse"),
    ("google/gemma-4-31B-it", "842da3794eaa0b77d5f08bae87a17459d91ff475", "/workspace/models/gemma"),
]
def fetch(item):
    repo, revision, target = item
    snapshot_download(repo_id=repo, revision=revision, local_dir=target, max_workers=8)
    return repo
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for repo in pool.map(fetch, models):
        print(f"model_downloaded={repo}", flush=True)
PY

sha256sum \
  "$workspace/models/qwen/config.json" \
  "$workspace/models/muse/config.json" \
  "$workspace/models/gemma/config.json" \
  > "$results/config/model-config-sha256.txt"

for task in S1 M1 L1; do
  target="$state/base/$task"
  rm -rf "$target"
  mkdir -p "$target"
  cp -a "$benchmark/bundles/$task/." "$target/"
  (cd "$target" && npm ci --ignore-scripts --no-audit --no-fund > "$results/logs/npm-$task.log" 2>&1)
done

mkdir -p "$dependencies"
for task in S1 M1 L1; do
  mv "$state/base/$task/node_modules" "$dependencies/$task"
done
chmod -R a-w "$dependencies"
chmod -R a+rX "$dependencies"

# The persistent workspace is a FUSE mount that forces permissive modes. Once
# the private local copies are verified, remove the exposed source and bases.
test -f "$benchmark/scripts/ms4/remote-run-pilot.sh"
test -d "$dependencies/S1"
test -d "$dependencies/M1"
test -d "$dependencies/L1"
rm -rf "$benchmark_source"

"$project/runpod/launch-stack.sh" optimized | tee "$results/logs/launch-stack.log"
chmod -R go-rwx "$workspace/models" "$state/base"

{
  source /etc/os-release
  printf 'os=%s\n' "$PRETTY_NAME"
  printf 'kernel=%s\n' "$(uname -r)"
  printf 'node=%s\n' "$(node --version)"
  printf 'pi=%s\n' "$("$workspace/bin/pi" --version 2>/dev/null || true)"
  printf 'vllm=%s\n' "$("$workspace/venvs/vllm/bin/python" -c 'import vllm; print(vllm.__version__)')"
  printf 'gpu_count=%s\n' "$(nvidia-smi -L | wc -l)"
} > "$results/config/runtime.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$results/bootstrap-completed-at.txt"
