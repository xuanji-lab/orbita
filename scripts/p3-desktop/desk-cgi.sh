#!/bin/sh
# ORBITA L3 桌面服务 —— guest 内的 CGI（BusyBox httpd 跑它）。
#
# 为什么是 HTTP 而不是串口 / SSH：
#   - 8250 串口没有流控，整行灌进去会丢字符（P3-1 实测，见 config.mjs 的注释），当不了控制通道；
#   - QEMU 的 virtio-serial 要 guest 里另起一个读设备的进程，等于再造一条私有协议；
#   - SSH（dropbear）能用，但每一条命令都要握手 / 建进程 / 拼转义，主机侧还得带一个 ssh 客户端；
#   - HTTP 是唯一一条宿主→guest 的**现成**通路：QEMU `-netdev user,hostfwd=` 已经把 guest 的
#     一个回环端口映到宿主 127.0.0.1，P3-2 的 RFB 就是这么出去的。于是 guest 侧只要 BusyBox
#     自带的 httpd + 这个脚本，不需要任何二进制、不需要编译。
#
# 协议（另一端是宿主的 src/main/computer-use/qemu-guest.ts，改一端必须改另一端）：
#   POST /cgi-bin/desk
#   体 = 每行一个 `key=value`，第一行必须是 cmd=…。值**不转义**：文本一律 base64，
#        所以既不用 URL 编码，也不用在 shell 里解析 JSON（本脚本是 POSIX sh）。
#        若 guest 启动参数里带了 orbita_token=…，每个请求还要带 t=<token>。
#   回执 = application/json 的 {"ok":true,…} 或 {"ok":false,"error":"…"}
#          shot 例外：体是 PNG 原始字节，尺寸在 X-Desk-Width / X-Desk-Height 头里。
#
# 命令（都是**桌面原语**，不是 Windows 桥的复刻：这里没有 UIA，也没有 SendInput）：
#   ping             → {ok,w,h,desktop}                         屏幕尺寸与桌面服务是否在
#   shot [thumb=PCT] → PNG                                      整屏截图（scrot → PNG）
#   type b64         → {}                                       把 base64 解出来的文本打进焦点窗口
#   key b64          → {}                                       按一个键/组合（xdotool 名字：Return / ctrl+s）
#   winlist          → {windows:[{id,title,x,y,w,h,pid}]}       可见顶层窗口（xdotool search）
#   exec b64 [secs]  → {code,stdout}                            在 guest 里跑一条 shell 命令
#
# **指针（移动/点击/滚轮）不在这里**：它们走 guest 里 Xvnc 的 RFB 设备（宿主 src/main/computer-use/
# qemu-rfb.ts）。原因写在那个文件头上：xdotool 的 XTEST 事件在 GTK 的菜单栏上是二等公民——
# 菜单闪一下就关（实测：按住不放时菜单在，一松手就没了），而 RFB 与真鼠标同级。键盘与打字留在
# 这里，因为 xdotool 替我们处理了任意 Unicode 与组合键名，实测可用。
set -u
export DISPLAY=:0
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
umask 022

TOKEN_FILE=/run/orbita-desk.token
TMP=/tmp/orbita-desk
mkdir -p "$TMP" 2>/dev/null || true

# ── 回执 ─────────────────────────────────────────────────────────────
# 头先发出去，体随后；httpd 只认「第一个空行之前是头」。错误也回 200 + ok:false：
# 宿主按 ok 判定，HTTP 状态码只用来区分「服务根本不在」。
ok_json() { printf 'Content-Type: application/json\r\nCache-Control: no-store\r\n\r\n%s' "$1"; }
err_json() {
  printf 'Content-Type: application/json\r\nCache-Control: no-store\r\n\r\n{"ok":false,"error":"%s"}' "$(json_text "$1")"
}

# 把任意文本变成 JSON 字符串的内容（不含两侧引号）：反斜杠、引号、制表符转义，换行 → \n
json_text() {
  printf '%s' "$1" |
    sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r//g' |
    awk 'BEGIN{ORS=""} {if (NR>1) printf "\\n"; printf "%s", $0}'
}

# ── 读请求 ───────────────────────────────────────────────────────────
LEN="${CONTENT_LENGTH:-0}"
case "$LEN" in '' | *[!0-9]*) LEN=0 ;; esac
BODY=$(head -c "$LEN" 2>/dev/null || true)

# 取一个字段的第一行（字段值里不会有换行：文本都 base64 过）
field() { printf '%s\n' "$BODY" | sed -n "s/^$1=//p" | head -n 1; }

CMD=$(field cmd)
if [ -z "$CMD" ]; then
  err_json "请求里没有 cmd 字段"
  exit 0
fi

# 令牌：宿主起 VM 时把 orbita_token=… 放进内核命令行，服务启动时抄到这里。
# 没配令牌（人工起 VM 调试）就不校验——那个形态下 guest 端口也只有宿主 hostfwd 能到。
if [ -s "$TOKEN_FILE" ]; then
  WANT=$(cat "$TOKEN_FILE")
  GOT=$(field t)
  if [ "$GOT" != "$WANT" ]; then
    printf 'Content-Type: application/json\r\n\r\n{"ok":false,"error":"令牌不符"}'
    exit 0
  fi
fi

# base64 字段 → 明文（多行 base64 也能解：base64 -d 会吃换行之外的内容，所以先去掉换行）
b64dec() { printf '%s' "$1" | base64 -d 2>/dev/null || true; }

screen_size() {
  # xdotool getdisplaygeometry → 「1280 800」；拿不到就退回 Xvnc 的固定几何
  set -- $(xdotool getdisplaygeometry 2>/dev/null)
  if [ -n "${1:-}" ] && [ -n "${2:-}" ]; then
    W=$1
    H=$2
  else
    W=0
    H=0
  fi
}

desktop_alive() {
  # 桌面「活着」= **整个会话**在：窗口管理器 + 桌面（画壁纸与图标）+ 面板。
  # 只判 xfwm4 会早报 1–2 秒：那时 root 窗口还是一片纯色（实测：P3-3 验收第一张截图
  # 是一整块 #1b2a33，宿主要拿着它去找图标）。用 -x 精确匹配进程名，别用 -f 模式串。
  for proc in xfwm4 xfdesktop xfce4-panel; do
    pgrep -x "$proc" >/dev/null 2>&1 || {
      echo 0
      return
    }
  done
  echo 1
}

case "$CMD" in
ping)
  screen_size
  printf 'Content-Type: application/json\r\nCache-Control: no-store\r\n\r\n'
  printf '{"ok":true,"w":%s,"h":%s,"desktop":%s,"version":"p3-guestd-1"}' "$W" "$H" "$(desktop_alive)"
  ;;

shot)
  # thumb=PCT：scrot 的百分比缩放。宿主按回图宽（maxWidth）算百分比，
  # 尺寸以 PNG 头里的真实值为准（百分比会取整，别指望 1280 的 50% 恰好是 640）。
  THUMB=$(field thumb)
  OUT="$TMP/shot-$$.png"
  rm -f "$OUT"
  if [ -n "$THUMB" ] && [ "$THUMB" -gt 0 ] 2>/dev/null && [ "$THUMB" -lt 100 ]; then
    scrot --silent --overwrite --thumb "$THUMB" "$OUT" >/dev/null 2>&1 ||
      scrot --silent -o -t "$THUMB" "$OUT" >/dev/null 2>&1
  else
    scrot --silent --overwrite "$OUT" >/dev/null 2>&1 || scrot --silent -o "$OUT" >/dev/null 2>&1
  fi
  if [ ! -s "$OUT" ]; then
    # scrot 偶尔会「什么都没写就退出」（X 服务正忙时 XGetImage 失败）。重试一次而不是
    # 直接失败：这条命令是模型的眼睛，一次瞬时的 X 抖动不该变成一次工具调用失败。
    sleep 0.25
    rm -f "$OUT"
    if [ -n "$THUMB" ] && [ "$THUMB" -gt 0 ] 2>/dev/null && [ "$THUMB" -lt 100 ]; then
      scrot --silent --overwrite --thumb "$THUMB" "$OUT" >/dev/null 2>&1 ||
        scrot --silent -o -t "$THUMB" "$OUT" >/dev/null 2>&1
    else
      scrot --silent --overwrite "$OUT" >/dev/null 2>&1 || scrot --silent -o "$OUT" >/dev/null 2>&1
    fi
  fi
  if [ ! -s "$OUT" ]; then
    rm -f "$OUT"
    err_json "截图失败：scrot 没有产出（X 桌面是不是没起来？用 exec 跑一下 xdpyinfo / pgrep -x xfwm4 看看）"
    exit 0
  fi
  printf 'Content-Type: image/png\r\nCache-Control: no-store\r\nX-Desk-Ok: 1\r\n\r\n'
  cat "$OUT"
  rm -f "$OUT"
  ;;

type)
  TEXT=$(b64dec "$(field b64)")
  if [ -z "$TEXT" ]; then
    ok_json '{"ok":true,"chars":0}'
    exit 0
  fi
  # --clearmodifiers：宿主那边如果留着 Shift/Ctrl 的状态，打出来的会是错字符。
  # --file -：文本从 stdin 进，绕开 shell 的引号与转义（文本里可能有 ' " $ 之类）。
  printf '%s' "$TEXT" | xdotool type --clearmodifiers --delay 20 --file - 2>/dev/null
  printf 'Content-Type: application/json\r\nCache-Control: no-store\r\n\r\n'
  printf '{"ok":true,"chars":%s}' "$(printf '%s' "$TEXT" | wc -c | tr -d ' ')"
  ;;

key)
  KEYNAME=$(b64dec "$(field b64)")
  case "$KEYNAME" in '' | *[!a-zA-Z0-9+\-_.,\ ]*)
    err_json "按键名里出现了不支持的字符：$KEYNAME"
    exit 0
    ;;
  esac
  # 失败重试一次：`xdotool key` 在 X 服务正忙（菜单动画 / 抓取切换）时会以非零退出，
  # 而那与「键名不认识」是两件事——把两者混成一句话会让模型以为语法错了（实测踩到）。
  if ! xdotool key --clearmodifiers "$KEYNAME" 2>/dev/null; then
    sleep 0.2
    if ! xdotool key --clearmodifiers "$KEYNAME" 2>/dev/null; then
      err_json "按键失败：xdotool 没接受 $KEYNAME。键名要用 X 的写法（Return / Escape / Page_Down / ctrl+s）；若键名没问题，就是 X 服务当时没接住，重试一次即可"
      exit 0
    fi
  fi
  ok_json '{"ok":true}'
  ;;

winlist)
  printf 'Content-Type: application/json\r\nCache-Control: no-store\r\n\r\n{"ok":true,"windows":['
  SEP=""
  # xdotool search --onlyvisible --name '' = 所有可见、有名字映射的顶层窗口
  xdotool search --onlyvisible --name '' 2>/dev/null | while read -r ID; do
    TITLE=$(xdotool getwindowname "$ID" 2>/dev/null | head -n 1)
    [ -z "$TITLE" ] && continue
    set -- $(xdotool getwindowgeometry --shell "$ID" 2>/dev/null |
      sed -n 's/^\(X\|Y\|WIDTH\|HEIGHT\)=//p' | tr '\n' ' ')
    [ $# -lt 4 ] && continue
    W=$3
    H=$4
    [ "$W" -lt 40 ] 2>/dev/null && continue
    [ "$H" -lt 40 ] 2>/dev/null && continue
    PID=$(xprop -id "$ID" _NET_WM_PID 2>/dev/null | sed -n 's/.*= \([0-9]*\)/\1/p' | head -n 1)
    printf '%s{"id":%s,"title":"%s","x":%s,"y":%s,"w":%s,"h":%s,"pid":%s}' \
      "$SEP" "$ID" "$(json_text "$TITLE")" "$1" "$2" "$W" "$H" "${PID:-0}"
    SEP=,
  done
  printf ']}'
  ;;

exec)
  CMDLINE=$(b64dec "$(field b64)")
  SECS=$(field secs)
  case "$SECS" in '' | *[!0-9]*) SECS=20 ;; esac
  OUT=$(
    cd /root 2>/dev/null || cd /
    timeout "$SECS" sh -c "$CMDLINE" 2>&1
    printf '\n__EXIT__%s' "$?"
  )
  CODE=$(printf '%s' "$OUT" | sed -n 's/.*__EXIT__\([0-9]*\)$/\1/p' | tail -n 1)
  BODYOUT=$(printf '%s' "$OUT" | sed 's/__EXIT__[0-9]*$//')
  printf 'Content-Type: application/json\r\nCache-Control: no-store\r\n\r\n'
  printf '{"ok":true,"code":%s,"stdout":"%s"}' "${CODE:-1}" "$(json_text "$BODYOUT")"
  ;;

*)
  err_json "不认的命令：$CMD"
  ;;
esac
