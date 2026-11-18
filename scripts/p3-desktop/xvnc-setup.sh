#!/bin/sh
# 在**已经在跑**的 guest 里装/修 VNC 桌面（Xvnc）。幂等，可反复跑。
#
# 为什么不用 QEMU 的 -vnc 呈现桌面：QEMU 10 on Windows + `-display none` 下，VNC 只会
# 呈现 VGA 文本 console（SeaBIOS 的启动画面），guest 的 virtio-gpu 图形 console 帧从不
# 出现（实测：X/xfce4-session/xfwm4 全在跑、connector connected/enabled，但 VNC 帧冻结在
# BIOS 文本画面上；qxl 变体同样如此）。Xvnc 把 X 渲染到内存再走 RFB，不依赖这条链路。
#
#   wget -qO- http://10.0.2.2:<port>/build/xvnc-setup.sh | sh
#
# 判定：guest 里 5900 在听，且 hostfwd 把宿主 127.0.0.1:5919 指到它。
set -u
MIRROR="http://10.0.2.2:${1:-5420}"
GEOMETRY="${2:-1280x800}"
log() { echo "XVNC: $*"; }
fail() {
  echo "XVNC_FAIL: $*"
  exit 1
}

log "sources"
cat >/etc/apk/repositories <<EOF
$MIRROR/alpine/v3.22/main
$MIRROR/alpine/v3.22/community
EOF

log "apk add tigervnc xterm"
apk update >/dev/null || fail "apk update"
apk add --no-cache tigervnc xterm || fail "apk add tigervnc"

log "xstartup"
mkdir -p /root/.vnc
cat >/root/.vnc/xstartup <<'EOF'
#!/bin/sh
xsetroot -solid '#1b2a33' 2>/dev/null
exec startxfce4
EOF
chmod +x /root/.vnc/xstartup

log "OpenRC 服务"
# Xvnc 是纯 X 服务器（不是 vncserver 包装脚本），不吃 -xstartup：X 起来之后要自己拉会话。
cat >/usr/local/bin/orbita-xvnc <<EOF
#!/bin/sh
# Xvnc 渲染到内存（不做 KMS），XFCE 会话在 :0 上跑；RFB 直接由 Xvnc 提供。
# /tmp 在 Alpine 默认落在根盘（不是 tmpfs），断电后 stale lock 会把下次启动堵死。
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
Xvnc :0 -geometry ${GEOMETRY} -depth 24 -rfbport 5900 -SecurityTypes None \\
     -noreset -alwaysshared >/var/log/xvnc.log 2>&1 &
XPID=\$!
for i in \$(seq 1 100); do [ -S /tmp/.X11-unix/X0 ] && break; sleep 0.1; done
export DISPLAY=:0
xsetroot -solid '#1b2a33' 2>/dev/null
dbus-launch --exit-with-session startxfce4 >/var/log/xfce.log 2>&1
wait \$XPID
EOF
chmod +x /usr/local/bin/orbita-xvnc

cat >/etc/init.d/xvnc <<'EOF'
#!/sbin/openrc-run
description="Orbita desktop (Xvnc + XFCE)"
command=/usr/local/bin/orbita-xvnc
command_background=true
pidfile="/run/xvnc.pid"
respawn_delay=2
respawn_max=0
depend() { need dbus; after net; }
EOF
chmod +x /etc/init.d/xvnc
rc-update add xvnc default 2>/dev/null || true

# 旧的 tty7 文本 X 会话不再需要（QEMU 的 VGA 只做 console 用）。
# 它占着 :0，必须先按 PID 停掉，再清 lock/socket，否则 Xvnc 起不来。
sed -i '/^tty7::respawn:/d' /etc/inittab 2>/dev/null || true
for pid in $(pgrep -f '^/usr/libexec/Xorg :0' 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
sleep 1
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
kill "$(cat /run/xvnc.pid 2>/dev/null)" 2>/dev/null || true
sleep 1
rc-service xvnc restart >/dev/null 2>&1 || rc-service xvnc start >/dev/null 2>&1 || true

sleep 4
if ! netstat -ltn 2>/dev/null | grep -q ':5900'; then
  echo "XVNC_FAIL: 5900 没在听，日志："
  tail -20 /var/log/xvnc.log 2>/dev/null
  exit 1
fi
log "OK，5900 在听"
