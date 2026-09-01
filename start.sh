#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

usage() {
  cat <<'EOF'
用法：
  ./start.sh review [端口]                 启动评审服务（默认 4400）
  ./start.sh test-site [端口]              启动测试站点（默认 4500）
  ./start.sh all [review端口] [site端口]   同时启动两个服务

示例：
  ./start.sh review
  ./start.sh test-site 8080
  ./start.sh all
  ./start.sh all 4401 4501
EOF
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && (( 1 <= 10#$1 && 10#$1 <= 65535 ))
}

check_port() {
  local label="$1"
  local port="$2"
  if ! valid_port "$port"; then
    echo "错误：${label}端口必须是 1 到 65535 之间的整数，当前值：${port}" >&2
    exit 2
  fi
}

start_review() {
  local port="$1"
  echo "启动评审服务：http://localhost:${port}"
  REVIEW_PORT="$port" node review/server.mjs
}

start_site() {
  local port="$1"
  echo "启动测试站点：http://localhost:${port}"
  SITE_PORT="$port" node test-site/server.mjs
}

command="${1:-}"

case "$command" in
  review)
    review_port="${2:-4400}"
    [[ $# -le 2 ]] || { usage >&2; exit 2; }
    check_port "review " "$review_port"
    start_review "$review_port"
    ;;

  test-site|site)
    site_port="${2:-4500}"
    [[ $# -le 2 ]] || { usage >&2; exit 2; }
    check_port "test-site " "$site_port"
    start_site "$site_port"
    ;;

  all)
    review_port="${2:-4400}"
    site_port="${3:-4500}"
    [[ $# -le 3 ]] || { usage >&2; exit 2; }
    check_port "review " "$review_port"
    check_port "test-site " "$site_port"
    if [[ "$review_port" == "$site_port" ]]; then
      echo "错误：两个服务不能使用同一个端口。" >&2
      exit 2
    fi

    cleanup() {
      trap - INT TERM EXIT
      kill "$review_pid" "$site_pid" 2>/dev/null || true
      wait "$review_pid" "$site_pid" 2>/dev/null || true
    }
    trap cleanup INT TERM EXIT

    start_review "$review_port" &
    review_pid=$!
    start_site "$site_port" &
    site_pid=$!

    echo "两个服务已启动，按 Ctrl+C 停止。"
    wait -n "$review_pid" "$site_pid"
    ;;

  -h|--help|help)
    usage
    ;;

  *)
    [[ -z "$command" ]] || echo "错误：未知入口“${command}”。" >&2
    usage >&2
    exit 2
    ;;
esac
