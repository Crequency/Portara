#!/bin/sh
# Portara 容器入口：Node + Caddy 双进程 supervisor。
#
# 为什么不让 Caddy 直接 exec 成 PID 1：
#   docker stop 只会把 SIGTERM 发给 PID 1。若 entrypoint 直接 exec caddy，
#   Node 收不到信号，只能等 docker 的 kill 超时后被 SIGKILL —— 连接、迁移、
#   Redis/PG 客户端都不会优雅关闭。这里由 shell 常驻 PID 1，转发信号并 wait 回收，
#   两个子进程都能正常退出，也不会产生僵尸。
set -eu

NODE_PID=""
CADDY_PID=""
CADDY_CONFIG="${PORTARA_CADDY_CONFIG:-/etc/caddy/Caddyfile}"

log() {
	printf '%s [entrypoint] %s\n' "$(date -u +%FT%TZ)" "$*"
}

shutdown() {
	rc="${1:-0}"
	# 防止重复进入
	trap - TERM INT
	log "收到退出信号，向 node(pid=${NODE_PID:-?}) 与 caddy(pid=${CADDY_PID:-?}) 发送 SIGTERM"
	if [ -n "$CADDY_PID" ] && kill -0 "$CADDY_PID" 2>/dev/null; then
		kill -TERM "$CADDY_PID" 2>/dev/null || true
	fi
	if [ -n "$NODE_PID" ] && kill -0 "$NODE_PID" 2>/dev/null; then
		kill -TERM "$NODE_PID" 2>/dev/null || true
	fi
	# wait 同时承担回收子进程（PID 1 的职责），避免僵尸
	if [ -n "$CADDY_PID" ]; then wait "$CADDY_PID" 2>/dev/null || true; fi
	if [ -n "$NODE_PID" ]; then wait "$NODE_PID" 2>/dev/null || true; fi
	log "两个进程均已退出（rc=$rc）"
	exit "$rc"
}

trap 'shutdown 0' TERM INT

log "启动 node（${PORTARA_HOST:-127.0.0.1}:${PORTARA_PORT:-52740}）"
node server/dist/index.js &
NODE_PID=$!

log "启动 caddy（config=$CADDY_CONFIG）"
caddy run --config "$CADDY_CONFIG" --adapter caddyfile &
CADDY_PID=$!

while kill -0 "$NODE_PID" 2>/dev/null && kill -0 "$CADDY_PID" 2>/dev/null; do
	sleep 1
done

# 正常收到 TERM 时上面的 trap 已经接管；走到这里说明有子进程提前退出
trap - TERM INT
if ! kill -0 "$NODE_PID" 2>/dev/null; then
	log "node 已退出，停止 caddy"
	wait "$NODE_PID" || rc=$?
	kill -TERM "$CADDY_PID" 2>/dev/null || true
	wait "$CADDY_PID" 2>/dev/null || true
	exit "${rc:-1}"
else
	log "caddy 已退出，停止 node"
	wait "$CADDY_PID" || rc=$?
	kill -TERM "$NODE_PID" 2>/dev/null || true
	wait "$NODE_PID" 2>/dev/null || true
	exit "${rc:-1}"
fi
