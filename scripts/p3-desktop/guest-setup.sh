#!/bin/sh
# 在 Alpine ramdisk 里把「XFCE 桌面 + Chromium + 中文字体」装进 /dev/vda（整盘 ext4）。
#
# 由 build-image.mjs 起 apk 镜像代理后下发：
#   wget -O /tmp/s.sh http://10.0.2.2:<port>/build/guest-setup.sh && sh /tmp/s.sh <port> <linux-virt 版本>
#
# 做法：把 ramdisk 自己的根（完整 Alpine minirootfs，含 apk 与 /lib/apk/db）cp -a 到磁盘，
# 再 chroot 进去用 apk 装剩下的。**不用 apk --root 引导**：那条路要在目标根还没有 /bin/sh
# 的时候跑 post-install 脚本（chroot 内 exec /bin/sh 会 ENOENT），是 bootstrap 经典坑。
#
# 组件级装 XFCE，不装 xfce4 meta，也不装 tumbler（缩略图服务，白吃 120MiB）。
set -u
PORT="${1:?mirror port}"
KVERSION="${2:?linux-virt 版本，必须与宿主 initramfs 里的模块同版本}"
MIRROR="http://10.0.2.2:${PORT}"
log() { echo "BUILD: $*"; }
fail() {
  echo "BUILD_FAIL: $*"
  exit 1
}

log "repositories → $MIRROR"
mkdir -p /etc/apk
cat >/etc/apk/repositories <<EOF
$MIRROR/alpine/v3.22/main
$MIRROR/alpine/v3.22/community
EOF

log "apk update (ramdisk)"
apk update >/dev/null || fail "apk update"

log "e2fsprogs（ramdisk 里没有 mkfs.ext4，这是必须的一步）"
apk add --no-cache e2fsprogs >/dev/null || fail "e2fsprogs"

log "mkfs.ext4 → /dev/vda"
mkfs.ext4 -q -F -L orbita -m 1 /dev/vda || fail "mkfs.ext4"
mkdir -p /target
mount /dev/vda /target || fail "mount /dev/vda"

log "把 ramdisk 根 cp -a 到磁盘（符号链接/权限原样）"
for d in bin etc home lib media mnt opt root sbin srv usr var; do
  [ -e "/$d" ] && cp -a "/$d" /target/ || fail "cp -a /$d"
done
mkdir -p /target/proc /target/sys /target/dev /target/run /target/tmp /target/newroot /target/var/tmp
chmod 1777 /target/tmp /target/var/tmp
cp /etc/apk/repositories /target/etc/apk/repositories
printf 'nameserver 10.0.2.3\n' >/target/etc/resolv.conf

mount -t proc proc /target/proc
mount -t sysfs sys /target/sys
mount -t devtmpfs dev /target/dev
mkdir -p /target/dev/pts
mount -t devpts devpts /target/dev/pts

log "bootstrap：alpine-base + openrc（chroot 内）"
chroot /target /bin/sh -c 'apk update >/dev/null && apk add --no-cache --force-overwrite alpine-base openrc alpine-conf eudev dbus' ||
  fail "chroot bootstrap"

log "装桌面组件（chroot 内）"
cat >/target/tmp/install-desktop.sh <<EOS
#!/bin/sh
set -e
# 组件级 XFCE：不装 xfce4 meta、不装 tumbler
# 不装 xorg-server / xinit / xauth / xf86-input-*：Xvnc 自己就是 X 服务器，输入由 RFB
# 直接喂给它，这几包只是让镜像白胖（挤不进 1.1GiB 预算）。
apk add --no-cache \\
  linux-virt=$KVERSION \\
  xsetroot \\
  xfwm4 xfce4-panel xfce4-session xfce4-settings xfce4-terminal xfce4-appfinder xfdesktop thunar \\
  adwaita-icon-theme hicolor-icon-theme \\
  font-noto-cjk font-dejavu \\
  tigervnc \\
  chromium
EOS
chmod +x /target/tmp/install-desktop.sh
chroot /target /bin/sh /tmp/install-desktop.sh || fail "chroot apk add desktop"
rm -f /target/tmp/install-desktop.sh

log "配置：服务 / 网络 / 控制台 / 图形会话"
cat >/target/tmp/configure.sh <<'EOS'
#!/bin/sh
set -e
echo orbita > /etc/hostname
# xauth 需要有 hostname 的解析，否则每条 xauth 命令都报 bad display name
printf '127.0.0.1 orbita\n' >> /etc/hosts
printf 'auto lo\niface lo inet loopback\n\nauto eth0\niface eth0 inet dhcp\n' > /etc/network/interfaces
printf 'LABEL=orbita / ext4 rw,relatime 0 1\n' > /etc/fstab
for svc in dbus networking; do rc-update add "$svc" default 2>/dev/null || true; done
for svc in udev udev-trigger udev-settle; do rc-update add "$svc" sysinit 2>/dev/null || true; done

# ttyS0 只留一个人工调试口（无口令 root shell）。**不用裸串口做控制协议**：
# 8250 无流控，长命令会丢字符（实测 "cat /tmp/x.log" → "cat /tp/x.lg"）。
grep -q '^ttyS0::' /etc/inittab || cat >>/etc/inittab <<'EOF'

ttyS0::respawn:/sbin/getty -n -l /bin/sh -L ttyS0 115200 vt100
EOF

# 桌面：Xvnc（X 渲染到内存 + RFB），不走 QEMU 的 -vnc —— QEMU 10/Windows 下那个 VNC
# 只呈现 VGA 文本 console（SeaBIOS 画面），guest 的图形 console 帧根本不出现。
cat >/usr/local/bin/orbita-xvnc <<'EOF'
#!/bin/sh
# /tmp 在 Alpine 默认落在根盘，断电后 stale lock 会把下次启动堵死，先清
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
Xvnc :0 -geometry 1280x800 -depth 24 -rfbport 5900 -SecurityTypes None \
     -noreset -alwaysshared >/var/log/xvnc.log 2>&1 &
XPID=$!
for i in $(seq 1 100); do [ -S /tmp/.X11-unix/X0 ] && break; sleep 0.1; done
export DISPLAY=:0
xsetroot -solid '#1b2a33' 2>/dev/null
dbus-launch --exit-with-session startxfce4 >/var/log/xfce.log 2>&1
wait $XPID
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
# 必须在 init 脚本就位之后再 rc-update，否则报 "service xvnc not found"，桌面永不起来
rc-update add xvnc default 2>/dev/null || true

# 根用户跑 chromium 必须 --no-sandbox（VM 自己就是沙箱）
cat >/usr/local/bin/orbita-chromium <<'EOF'
#!/bin/sh
exec /usr/bin/chromium --no-sandbox --no-first-run --disable-dev-shm-usage "$@"
EOF
chmod +x /usr/local/bin/orbita-chromium

# 中文字体验证用的一句话（截图里 cat 它，能看出有没有把中文渲染成方块）
printf '中文显示测试 OK —— Orbita P3\n' > /root/cjk.txt
mkdir -p /var/log
EOS
chmod +x /target/tmp/configure.sh
chroot /target /bin/sh /tmp/configure.sh || fail "configure"
rm -f /target/tmp/configure.sh

log "确认关键文件"
# 模块目录名是内核 release（6.12.117-0-virt），不是包版本（6.12.117-r0）：用 uname -r 对齐
for f in /target/sbin/init /target/bin/sh /target/usr/bin/Xvnc /target/usr/bin/startxfce4 /target/usr/bin/chromium "/target/lib/modules/$(uname -r)"; do
  [ -e "$f" ] || fail "missing $f"
done
log "占用：$(du -sm /target 2>/dev/null | cut -f1)MiB"

log "收尾"
sync
umount /target/dev/pts 2>/dev/null || true
umount /target/dev 2>/dev/null || true
umount /target/sys 2>/dev/null || true
umount /target/proc 2>/dev/null || true
umount /target 2>/dev/null || true
echo "BUILD_OK"
