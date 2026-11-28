#!/bin/sh
# 在**已经在跑**的 guest 里装/修 L3 桌面服务（xdotool + scrot + BusyBox httpd + CGI）。
# 幂等，可反复跑：镜像重建由 build-image.mjs 的最后一步调用它，平时改脚本也可以直接重跑。
#
#   wget -qO- http://10.0.2.2:<port>/build/desk-service.sh | sh
#
# 装什么、为什么：
#   - xdotool：X11 的输入注入（mousemove / mousedown / type / key）。Linux 侧没有 SendInput，
#     它是这一层的标准原语；
#   - scrot：整屏截图**直接写 PNG**（20KB 的包）。不选 ImageMagick / netpbm：镜像预算只剩
#     8MiB（build-image.mjs 的 budgetMiB=1126，P3-2 出包是 1117.8MiB），netpbm 装完要 6.9MiB；
#     也不选 xwd + 转换（xwd 只吐 raw，还得在宿主解格式）；
#   - httpd：busybox-extras 里的 applet（110KB）。Alpine 的基础 busybox **没有编译 httpd**
#     （`busybox --list` 里找不到它，实测），而 lighttpd 装完要 0.9MiB、uhttpd 要一套 libubox。
#     busybox-extras 的 httpd 带 CGI，正好够用。CGI 脚本见 desk-cgi.sh。
#
# 端口 8080 固定：QEMU 侧用 hostfwd 把宿主的一个回环端口映到它，宿主端口每次现挑
# （见 src/main/computer-use/qemu.ts 的端口分配），guest 这边不必知道宿主用了哪个。
set -u
PORT="${1:-5420}"
MIRROR="http://10.0.2.2:${PORT}"
log() { echo "DESK: $*"; }
fail() {
  echo "DESK_FAIL: $*"
  exit 1
}

log "sources → $MIRROR"
cat >/etc/apk/repositories <<EOF
$MIRROR/alpine/v3.22/main
$MIRROR/alpine/v3.22/community
EOF

# exo：Thunar 的「Open Terminal Here」等自定义动作是 `exo-open --launch TerminalEmulator`，
# 而镜像只装了 xfce4-terminal、没装 exo（exo-open 不在 PATH）。缺它的表现是「菜单点了没反应」——
# 命令行直跑 exo-open 是 rc=127，但菜单里没有任何提示（P3-3 实测踩到，排查了一轮）。
log "apk add xdotool scrot busybox-extras exo"
apk update >/dev/null || fail "apk update"
apk add --no-cache xdotool scrot busybox-extras exo >/dev/null || fail "apk add xdotool scrot busybox-extras exo"
command -v exo-open >/dev/null || fail "装了 exo 却找不到 exo-open"
# httpd 的真实落点（busybox-extras 装的是 applet 链接，不同版本落 /usr/sbin 或 /sbin）
HTTPD=$(command -v httpd 2>/dev/null || true)
[ -n "$HTTPD" ] || fail "装了 busybox-extras 却找不到 httpd"

log "CGI"
mkdir -p /var/www/orbita/cgi-bin || fail "mkdir www"
wget -qO /var/www/orbita/cgi-bin/desk "$MIRROR/build/desk-cgi.sh" || fail "取 desk-cgi.sh"
chmod 0755 /var/www/orbita/cgi-bin/desk

log "令牌（宿主起 VM 时用 orbita_token=… 传进来）"
TOKEN=$(sed -n 's/.*orbita_token=\([A-Za-z0-9]*\).*/\1/p' /proc/cmdline | head -n 1)
if [ -n "$TOKEN" ]; then
  printf '%s' "$TOKEN" >/run/orbita-desk.token
  log "已配置令牌（${#TOKEN} 字符）"
else
  rm -f /run/orbita-desk.token
  log "内核命令行里没有 orbita_token，服务不校验令牌（只建议人工调试时这样起）"
fi

log "OpenRC 服务"
cat >/etc/init.d/orbita-desk <<'EOF'
#!/sbin/openrc-run
description="Orbita desktop service (BusyBox httpd + CGI)"
command=__HTTPD__
command_args="-f -p 8080 -h /var/www/orbita"
command_background=true
pidfile="/run/orbita-desk.pid"
respawn_delay=2
respawn_max=0
start_pre() {
  # 令牌每局都从内核命令行重读：同一个镜像可以被不同实例以不同令牌启动
  TOKEN=$(sed -n 's/.*orbita_token=\([A-Za-z0-9]*\).*/\1/p' /proc/cmdline | head -n 1)
  if [ -n "$TOKEN" ]; then
    printf '%s' "$TOKEN" >/run/orbita-desk.token
  else
    rm -f /run/orbita-desk.token
  fi
  mkdir -p /tmp/orbita-desk
}
depend() { need net; }
EOF
chmod 0755 /etc/init.d/orbita-desk
sed -i "s|__HTTPD__|$HTTPD|" /etc/init.d/orbita-desk
rc-update add orbita-desk default 2>/dev/null || true
rc-service orbita-desk restart >/dev/null 2>&1 || rc-service orbita-desk start >/dev/null 2>&1 || true

# httpd 起来要一点时间（bind + fork），这里等到能应答为止
i=0
while [ "$i" -lt 50 ]; do
  OUT=$(wget -q -O - --post-data 'cmd=ping' http://127.0.0.1:8080/cgi-bin/desk 2>/dev/null)
  case "$OUT" in *'"ok":true'*) break ;; esac
  i=$((i + 1))
  sleep 0.2
done
if [ "$i" -ge 50 ]; then
  echo "DESK_FAIL: 8080 没有应答；httpd 日志："
  tail -20 /var/log/messages 2>/dev/null
  exit 1
fi

log "应答：$OUT"
# 桌面尺寸取自 xdotool：宿主用「回图宽 / 原生宽」换算坐标，原生宽必须是真的。
# 这里必须显式给 DISPLAY：本脚本不是 CGI（CGI 自己 export DISPLAY）。
if ! DISPLAY=:0 xdotool getdisplaygeometry >/dev/null 2>&1; then
  fail "xdotool 连不上 X（DISPLAY=:0）；Xvnc 起来了吗"
fi
log "OK ${OUT}"
