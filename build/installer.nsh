; ── 安装时的 Hyper-V 提示（electron-builder 的默认 include：build/installer.nsh）──────────
;
; 为什么要有这一段：用户装完 Orbita、在「设置 › 实验功能 › 电脑使用」点「启用沙箱」时，
; 没人告诉他这一步会**同时打开 Hyper-V 平台**——微软自己写明 Hyper-V 与第三方虚拟机不兼容，
; 这台机器上已有的 VMware / VirtualBox 虚拟机可能起不来或明显变慢。等他按完指引才发现
; 虚拟机废了，就是产品级事故（2026-10 产品裁决：这件事必须在动手之前说）。
;
; 为什么落在这里：electron-builder 的 nsis 配置没写 `include` 时，默认就找
; `<buildResources>/installer.nsh`（buildResources = build/，见 package.json），
; 所以我们只需要这个文件，打包配置一行都不用改（少改一处就少一处出包风险）。
;
; 两条硬约束：
;   1. **静默安装不能弹框**（/S 是企业分发与自动更新的路径，弹一个框会把流程挂死）——
;      所以先 IfSilent 跳过；
;   2. 点「取消」= 不装（.onInit 里 Quit 会中止安装），文案里必须说清，否则用户以为
;      点掉提示就行、结果发现什么都没装。
;
; 挂在 customInit（electron-builder 的 templates/nsis/installer.nsi 会把它插进 .onInit，
; 且只在安装器里插、卸载器不插），所以它在解包之前、安装模式选完之后出现。
;
; 文案与 src/main/computer-use/capability.ts 的 HYPERVISOR_CONFLICT_NOTE 是同一件事的两份
; （安装器是 NSIS，读不到那段 TS）。改字时两处一起看。
;
; 编码：本文件是 UTF-8 **带 BOM**。makensis 靠 BOM 认 UTF-8，去掉 BOM 中文会变乱码。

!macro customInit
  IfSilent orbitaHypervisorNoticeDone
  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "提示：Orbita 的「电脑使用」功能要用 Windows 沙箱，而启用 Windows 沙箱会同时打开 Hyper-V 平台。$\r$\n$\r$\n微软明确说明 Hyper-V 与第三方虚拟机不兼容：这台机器上已有的 VMware / VirtualBox 虚拟机可能无法启动，或明显变慢（新版本可以用兼容模式，但仍会变慢）。$\r$\n$\r$\n不启用沙箱也能正常使用 Orbita 的其它功能；需要时再到「设置 › 实验功能 › 电脑使用」自己打开。$\r$\n$\r$\n点「确定」继续安装，点「取消」退出安装器。" IDOK orbitaHypervisorNoticeDone
  Quit
  orbitaHypervisorNoticeDone:
!macroend
