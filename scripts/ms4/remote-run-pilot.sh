#!/usr/bin/env bash
set -Eeuo pipefail

workspace=/workspace
benchmark=/opt/kiln-benchmark
state=/opt/kiln-ms4
dependencies=/opt/kiln-node-modules
published_results="$workspace/results/ms4-pilot-20261022"
results="$state/results/ms4-pilot-20261022"
relay=/usr/local/libexec/kiln-socket-relay.py
seccomp=/usr/local/libexec/kiln-seccomp-exec.py
node_unix_fetch=/usr/local/libexec/kiln-node-unix-fetch.cjs
pi="$workspace/bin/pi"
mkdir -p "$state/runs" "$state/sockets" "$results/runs" "$results/telemetry" "$results/config" "$results/logs"
# A prior interrupted or rejected pilot may have published a completion marker
# during its EXIT cleanup. Never carry that marker into a new controller run.
rm -f "$results/pilot-completed-at.txt" "$published_results/pilot-completed-at.txt"
if [[ -d "$published_results/config" ]]; then
  cp -a "$published_results/config/." "$results/config/"
fi
# Agent users need traverse-only access to the runtime root so they can reach
# their group-scoped relay socket and owned run directory. The immutable task
# bases remain root-only and are never exposed through this path.
chmod 0711 "$state" "$state/runs"
chmod 0700 "$state/base"

declare -A ports=([qwen]=8001 [muse]=8002 [gemma]=8003)
declare -A providers=([qwen]=vllm-qwen [muse]=vllm-muse [gemma]=vllm-gemma)
declare -A repositories=([qwen]=Qwen/Qwen3.8-27B [muse]=meta-models/Muse-Glimmer-30B [gemma]=google/gemma-4-31B-it)
declare -A deadlines=([S1]=600 [M1]=1800 [L1]=7200)

cleanup() {
  jobs -pr | xargs -r kill 2>/dev/null || true
  wait 2>/dev/null || true
  mkdir -p "$published_results"
  cp -a "$results/." "$published_results/"
}
trap cleanup EXIT INT TERM

for model in qwen muse gemma; do
  group="kiln-$model"
  getent group "$group" >/dev/null || groupadd --system "$group"
  socket="$state/sockets/$model.sock"
  rm -f "$socket"
  python3 "$relay" unix-to-tcp "$socket" 127.0.0.1 "${ports[$model]}" \
    > "$results/logs/relay-$model.log" 2>&1 &
  for _ in $(seq 1 100); do [[ -S "$socket" ]] && break; sleep 0.1; done
  [[ -S "$socket" ]] || { echo "relay failed for $model" >&2; exit 2; }
  chgrp "$group" "$socket"
  chmod 0660 "$socket"
done

make_user() {
  local run_id=$1 model=$2
  local user="kiln-${model}-${run_id%%-*}"
  local group="kiln-$model"
  if ! id "$user" >/dev/null 2>&1; then
    useradd --system --create-home --gid "$group" --shell /bin/bash "$user"
  fi
  chmod 0700 "/home/$user"
  printf '%s' "$user"
}

write_pi_config() {
  local user=$1 model=$2
  local home="/home/$user"
  local model_fields
  case "$model" in
    qwen)
      model_fields='"thinkingLevelMap":{"off":"none","minimal":"low","low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"xhigh"},"compat":{"supportsDeveloperRole":false,"supportsStrictMode":false,"supportsReasoningEffort":false,"thinkingFormat":"qwen-chat-template","maxTokensField":"max_tokens"}'
      ;;
    muse)
      model_fields='"compat":{"supportsDeveloperRole":false,"supportsStrictMode":false,"supportsReasoningEffort":false,"maxTokensField":"max_tokens"}'
      ;;
    gemma)
      model_fields='"thinkingLevelMap":{"off":"none","medium":"medium"},"compat":{"supportsDeveloperRole":false,"supportsStrictMode":false,"supportsReasoningEffort":true,"maxTokensField":"max_tokens"}'
      ;;
  esac
  mkdir -p "$home/.pi/agent"
  cat > "$home/.pi/agent/models.json" <<JSON
{"providers":{"${providers[$model]}":{"name":"MS4 isolated ${model}","baseUrl":"http://127.0.0.1:8000/v1","api":"openai-completions","apiKey":"\$VLLM_API_KEY","models":[{"id":"${repositories[$model]}","name":"${model}","reasoning":true,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":65536,"maxTokens":8192,${model_fields}}]}}}
JSON
  printf '{"defaultProvider":"%s","defaultModel":"%s","defaultThinkingLevel":"off","quietStartup":true}\n' \
    "${providers[$model]}" "${repositories[$model]}" > "$home/.pi/agent/settings.json"
  chown -R "$user:kiln-$model" "$home/.pi"
  chmod -R go-rwx "$home/.pi"
}

namespace_command() {
  local user=$1 model=$2 workspace_path=$3 prompt_path=$4 output=$5 stderr=$6 timeout_s=$7
  local suffix=()
  [[ "$model" == muse ]] && suffix=(--append-system-prompt "Reasoning strength: low")
  (
    cd "$workspace_path"
    timeout --signal=TERM --kill-after=20s "$timeout_s" \
      runuser -u "$user" -- env -i HOME="/home/$user" USER="$user" LOGNAME="$user" \
        PATH="/workspace/bin:/workspace/pi/node_modules/.bin:/usr/local/bin:/usr/bin:/bin" \
        PI_OFFLINE=1 VLLM_API_KEY=local-vllm KILN_VLLM_SOCKET="$state/sockets/$model.sock" \
        NODE_OPTIONS="--require=$node_unix_fetch" \
        python3 "$seccomp" "$pi" --offline --provider "${providers[$model]}" \
        --model "${repositories[$model]}" --thinking off --mode json --print --no-session \
        --approve --tools read,bash,edit,write "${suffix[@]}" "$(cat "$benchmark/prompts/agent/EXECUTION-POLICY.md")

$(cat "$prompt_path")"
  ) \
    > "$output" 2> "$stderr"
}

attest_model() {
  local model=$1 user run_id="attest-$model"
  local smoke="$results/config/pi-smoke-$model.jsonl"
  local smoke_stderr="$results/config/pi-smoke-$model.stderr.log"
  local smoke_suffix=()
  [[ "$model" == muse ]] && smoke_suffix=(--append-system-prompt "Reasoning strength: low")
  user=$(make_user "$run_id" "$model")
  write_pi_config "$user" "$model"
  local other=qwen
  [[ "$model" == qwen ]] && other=muse
  local report="$results/config/isolation-$model.txt"
  {
    printf "selected_endpoint="
    runuser -u "$user" -- env -i HOME="/home/$user" PATH="/usr/local/bin:/usr/bin:/bin" \
      KILN_VLLM_SOCKET="$state/sockets/$model.sock" NODE_OPTIONS="--require=$node_unix_fetch" \
      python3 "$seccomp" node -e 'fetch("http://127.0.0.1:8000/health").then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))' \
      && echo reachable || echo blocked
    printf "host_loopback_direct="
    runuser -u "$user" -- env -i PATH="/usr/local/bin:/usr/bin:/bin" \
      python3 "$seccomp" curl -fsS --max-time 2 http://127.0.0.1:8001/health >/dev/null 2>&1 \
      && echo reachable || echo blocked
    printf "external_network="
    runuser -u "$user" -- env -i PATH="/usr/local/bin:/usr/bin:/bin" \
      python3 "$seccomp" python3 -c 'import socket; socket.create_connection(("1.1.1.1", 443), 2)' >/dev/null 2>&1 \
      && echo reachable || echo blocked
    printf "non_unix_socket="
    runuser -u "$user" -- env -i PATH="/usr/local/bin:/usr/bin:/bin" \
      python3 "$seccomp" python3 -c 'import socket; socket.socket(socket.AF_NETLINK, socket.SOCK_RAW)' >/dev/null 2>&1 \
      && echo reachable || echo blocked
    printf "other_model_socket="; runuser -u "$user" -- test -r "$state/sockets/$other.sock" && echo readable || echo blocked
    printf "root_home="; runuser -u "$user" -- test -r /root/.ssh/authorized_keys && echo readable || echo blocked
    printf "pi_completion="
    if timeout --signal=TERM --kill-after=10s 180 \
      runuser -u "$user" -- env -i HOME="/home/$user" USER="$user" LOGNAME="$user" \
        PATH="/workspace/bin:/workspace/pi/node_modules/.bin:/usr/local/bin:/usr/bin:/bin" \
        PI_OFFLINE=1 VLLM_API_KEY=local-vllm KILN_VLLM_SOCKET="$state/sockets/$model.sock" \
        NODE_OPTIONS="--require=$node_unix_fetch" \
        python3 "$seccomp" "$pi" --offline --provider "${providers[$model]}" \
        --model "${repositories[$model]}" --thinking off --mode json --print --no-session \
        --tools read "${smoke_suffix[@]}" "Reply with exactly OK." \
        > "$smoke" 2> "$smoke_stderr" \
      && python3 -c 'import json,sys; rows=[json.loads(line) for line in open(sys.argv[1]) if line.strip()]; sys.exit(0 if any(row.get("type") == "message_end" and (row.get("message") or {}).get("role") == "assistant" and (row.get("message") or {}).get("stopReason") != "error" and ((row.get("message") or {}).get("usage") or {}).get("totalTokens", 0) > 0 for row in rows) else 1)' "$smoke"; then
      echo passed
    else
      echo blocked
    fi
  } > "$report"
  grep -qx 'selected_endpoint=reachable' "$report"
  grep -qx 'host_loopback_direct=blocked' "$report"
  grep -qx 'external_network=blocked' "$report"
  grep -qx 'non_unix_socket=blocked' "$report"
  grep -qx 'other_model_socket=blocked' "$report"
  grep -qx 'root_home=blocked' "$report"
  grep -qx 'pi_completion=passed' "$report"
}

for model in qwen muse gemma; do attest_model "$model"; done
date -u +%Y-%m-%dT%H:%M:%SZ > "$results/isolation-attested-at.txt"

if [[ "${MS4_ATTEST_ONLY:-0}" == 1 ]]; then
  exit 0
fi

nvidia-smi --query-gpu=timestamp,index,name,utilization.gpu,memory.used,temperature.gpu,power.draw \
  --format=csv,noheader,nounits -l 5 > "$results/telemetry/nvidia-smi.csv" &
telemetry_pid=$!

run_attempt() {
  local model=$1 task=$2
  local run_id="${task,,}-$model" user work run_root prompt
  user=$(make_user "$run_id" "$model")
  write_pi_config "$user" "$model"
  run_root="$state/runs/$run_id"
  work="$run_root/workspace"
  prompt="$benchmark/prompts/agent/$task.md"
  rm -rf "$run_root" "$results/runs/$run_id"
  mkdir -p "$work" "$results/runs/$run_id"
  cp -a "$state/base/$task/." "$work/"
  ln -s "$dependencies/$task" "$work/node_modules"
  (cd "$work" && git init -q && git config user.email benchmark@localhost && git config user.name benchmark && git add . ':!node_modules' && git commit -qm baseline)
  chown -R "$user:kiln-$model" "$run_root"
  chmod 0700 "$run_root" "$work"
  chown -R root:root "$work/.git"
  chmod -R a-w "$work/.git"
  local started finished rc=0
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  namespace_command "$user" "$model" "$work" "$prompt" \
    "$results/runs/$run_id/agent.jsonl" "$results/runs/$run_id/agent.stderr.log" "${deadlines[$task]}" || rc=$?
  finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  (cd "$work" && git -c safe.directory="$work" diff --binary -- . ':!node_modules') > "$results/runs/$run_id/candidate.patch"
  (cd "$work" && git -c safe.directory="$work" status --porcelain=v1 --untracked-files=all -- . ':!node_modules') > "$results/runs/$run_id/status.txt"
  tar --exclude='./.git' --exclude='./node_modules' -czf "$results/runs/$run_id/workspace.tar.gz" -C "$work" .
  sha256sum "$results/runs/$run_id/candidate.patch" > "$results/runs/$run_id/patch.sha256"
  sha256sum "$results/runs/$run_id/workspace.tar.gz" > "$results/runs/$run_id/workspace.sha256"
  printf '{"runId":"%s","taskId":"%s","modelId":"%s","startedAt":"%s","finishedAt":"%s","agentExitCode":%s,"deadlineSeconds":%s}\n' \
    "$run_id" "$task" "$model" "$started" "$finished" "$rc" "${deadlines[$task]}" > "$results/runs/$run_id/remote.json"
}

run_stream() {
  local model=$1
  for task in S1 M1 L1; do run_attempt "$model" "$task"; done
}

pids=()
for model in qwen muse gemma; do run_stream "$model" & pids+=("$!"); done
failed=0
for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
kill "$telemetry_pid" 2>/dev/null || true
wait "$telemetry_pid" 2>/dev/null || true
date -u +%Y-%m-%dT%H:%M:%SZ > "$results/pilot-completed-at.txt"
exit "$failed"
