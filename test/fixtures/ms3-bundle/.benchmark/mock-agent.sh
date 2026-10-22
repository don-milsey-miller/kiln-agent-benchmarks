#!/usr/bin/env bash
set -Eeuo pipefail

scenario=${1:?scenario required}
case "$scenario" in
  valid)
    printf 'fixed\n' > src/value.txt
    printf '{"type":"agent_end","scenario":"valid","usage":{"input_tokens":12,"output_tokens":5}}\n'
    ;;
  failing)
    printf 'still-wrong\n' > src/value.txt
    printf '{"type":"agent_end","scenario":"failing","usage":{"input_tokens":10,"output_tokens":3}}\n'
    ;;
  noop)
    printf '{"type":"agent_end","scenario":"noop","usage":{"input_tokens":4,"output_tokens":1}}\n'
    ;;
  timeout)
    token=${2:-kiln-ms3-timeout-descendant}
    bash -c "exec -a '$token' sleep 30" &
    while true; do sleep 1; done
    ;;
  canceled)
    printf '{"type":"agent_end","scenario":"canceled"}\n'
    exit 130
    ;;
  malformed)
    printf 'this is not JSONL\n'
    ;;
  agent-error)
    printf '{"type":"agent_error","scenario":"agent-error"}\n'
    exit 7
    ;;
  scope-violation)
    printf 'not allowed\n' > forbidden.txt
    printf '{"type":"agent_end","scenario":"scope-violation"}\n'
    ;;
  isolation-probe)
    windows_drive_visible=false
    [[ -e /mnt/c/Users ]] && windows_drive_visible=true
    network_reachable=false
    if timeout 1 bash -c 'exec 3<>/dev/tcp/1.1.1.1/80' 2>/dev/null; then network_reachable=true; fi
    host_secret_visible=false
    [[ -n "${KILN_BENCHMARK_SECRET:-}" ]] && host_secret_visible=true
    printf '{"type":"isolation_probe","windowsDriveVisible":%s,"networkReachable":%s,"hostSecretVisible":%s}\n' \
      "$windows_drive_visible" "$network_reachable" "$host_secret_visible"
    ;;
  *)
    printf '{"type":"agent_error","message":"unknown scenario"}\n'
    exit 7
    ;;
esac
