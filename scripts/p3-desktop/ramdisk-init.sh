#!/bin/sh
# Orbita 桌面 VM 的直启 init（在 initramfs 里跑，rdinit=/init）。
#
# 为什么自己写 init 而不是用 mkinitfs：Windows 上没有 chroot，装进磁盘的系统生不出
# 自己的 initramfs；而 Alpine 官方 netboot 的 initramfs 里没有 ext4 驱动（它只服务
# netboot/squashfs）。所以内核与模块从 linux-virt apk 里拆到宿主，initramfs 也在宿主
# 拼好——和 guest 的 /lib/modules 同源同版本，不需要任何「把文件弄出 qcow2」的通道。
#
# orbita.mode=build 时不碰磁盘，直接给 shell（造镜像阶段用）。
export PATH=/sbin:/bin:/usr/sbin:/usr/bin
mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t devtmpfs dev /dev 2>/dev/null
mkdir -p /dev/pts
mount -t devpts devpts /dev/pts 2>/dev/null

if grep -q orbita.mode=build /proc/cmdline; then
  echo "ORBITA_BUILD_SHELL_READY"
  exec /bin/sh
fi

modprobe virtio_blk 2>&1
modprobe ext4 2>&1
mkdir -p /newroot
if ! mount -t ext4 -o rw /dev/vda /newroot; then
  echo "ORBITA: mount /dev/vda failed, drop to shell"
  exec /bin/sh
fi
echo "ORBITA_SWITCH_ROOT"
exec switch_root /newroot /sbin/init
