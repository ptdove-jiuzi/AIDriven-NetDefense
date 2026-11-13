AIDriven NetDefense（网域智防）· Windows x64 便携包
================================================================

版本标签 : 0.0.1-rc.6（预发布打包标签，仅用于产物命名）
产品版本 : 0.0.1-rc.6（与安装包同版本；安装包的版本资源亦是此值）
载荷     : win32-x64-v17（daemon + console-next + 桌面壳）
平台     : Windows x64
作者     : PT-dove

【重要】0.0.1-rc.6 是「预发布」标签，只用来给这个 zip 命名。
它不是版本冻结声明，不代表 0.0.1 已发布、已签收或已达到发布标准。
正式版本在完整门禁通过并由维护者明确批准后另行冻结。


1. 这是什么
----------------------------------------------------------------
把本仓库已构建、已审计的 win32-x64 运行时载荷（v17）打成可直接
解压运行的 zip，另外补一个启动器、一个停止脚本和一份校验清单。

载荷 v17 = daemon + console-next（WebUI v2，6 页：概览/告警/分析/Agent/模型与用量/设置），加上 Windows 桌面壳
（通知区图标 + WebView2 内嵌界面）。桌面壳就在解压目录根部：
AIDrivenNetDefense.exe。

包内 payload 与构建产物逐字节一致：本包没有重建、没有重新编译、
没有改动载荷里的任何文件。50 832 个载荷文件，占用约 463.8 MiB。


2. 这不是什么
----------------------------------------------------------------
  * 不是安装器：不解压到 Program Files，不写注册表，不建开始菜单，
    不注册 Windows 服务，不写 ProgramData，不做卸载项。
    （需要这些请用安装版 Setup.exe，两者载荷相同。）
  * 未签名：没有代码签名、没有信任根、没有签名者校验。
  * 没有升级器：更新模块随桌面壳一起打包，但本版没有接到界面路由上，
    不检查、不下载、不回滚。
  * 只有 Windows x64 一种形态。
  * 没有真实模型凭据、没有模型权重、没有 API Key。
  * daemon 以 mock 采集模式运行：/healthz 报 degraded 是诚实值，
    不是故障。真实采集源下的 ok 状态本版未验证。


3. 系统要求
----------------------------------------------------------------
  * Windows 10/11 x64（本包只在 Windows 11 x64 上实测过；
    Windows 10 未验证，不得据此宣称支持）。
  * WebView2 运行时（桌面壳的界面容器）。Windows 11 自带；
    Windows 10 通常随 Edge 存在，缺失时壳会退回内置最小页面。
  * 解压后约 463.9 MiB（载荷）+ 约 1 MiB（启动器与清单）。
  * 不需要安装 Node.js —— 运行时已内嵌（v24.20.0）。
  * 不需要外网。桌面壳与 console 只监听 127.0.0.1。


4. 快速开始
----------------------------------------------------------------
  1) 解压整个 zip 到任意本地目录。
     路径可以含空格和中文，例如：
       D:\测试 目录\AIDriven Net Defense
     不要只解压一部分文件，也不要解开后把子目录单独搬走：
     桌面壳用**自身所在目录**当安装根，再去那里找 apps\daemon\bin.js、
     runtime\node\node.exe 与 console\，搬走任何一样都会起不来。

  2) 双击 AIDrivenNetDefense.exe。
     通知区出现图标即代表壳起来了；界面由壳内的 WebView2 打开，
     端口由壳运行时择定（记录在 %LOCALAPPDATA% 下该产品的
     data\shell\runtime.json 里）。再次双击不会开出第二个实例。

  3) 只想跑 stdio 的 worker（不要界面、不要托盘）时：
       start.cmd
     它会打印一行 READY http://127.0.0.1:<端口>/healthz，
     窗口保持打开即代表服务在跑；日志在同一目录的 run\ 下。

  4) 验证健康端点（另开一个窗口）：
       curl http://127.0.0.1:<端口>/healthz
     返回 HTTP 200；"status": "degraded" 与 "reasons": ["sources:none"]
     是 mock 采集模式下的预期值。

  5) 停止：
       stop.cmd
     它会请求 launcher 优雅退出、等 worker 一起退出、清掉临时
     attempt 树，并打印 launcherGone / workerGone / residual。
     看到 "residual": "none" 即表示无残留进程。
     桌面壳则用托盘菜单退出。

  可选参数（start.cmd）：
       --port 18080        固定健康端口（默认自动挑空闲端口）
       --attempt-root D:\x 指定临时 attempt 目录（必须在包目录之外）
       --verify            额外全量校验 manifests\files.sha256（约 40 s）
       --keep-attempt      停止后保留 attempt 树（排障用）
       --quiet             少输出

  退出码：
       0 正常    2 参数错误   3 已在运行
      90 内置运行时缺失   91 worker 入口缺失   92 无法解析包根
      93 完整性校验失败   94 attempt 准备失败   95 worker 未就绪


5. 校验（三行说明）
----------------------------------------------------------------
  1) 先校验 zip 本身：把发布页给出的 sha256 与下面命令的输出比对，
     Windows 可用 PowerShell：
       (Get-FileHash .\<zip 名> -Algorithm SHA256).Hash
     两串相同即压缩包在传输中未损坏。

  2) 再校验包内关键文件：SHA256SUMS 列出本包新增的文件与载荷里
     最该先核对的那几个（bundle.json / manifests\files.sha256 /
     runtime\node\node.exe / launch\ 的两个产物 / launcher\ 的脚本）。
     本包启动器每次启动都会自动核对其中与自身相关的部分，不符直接拒绝
     启动（退出码 93）。

  3) SHA256SUMS 共 13 行，**不覆盖全部 50 832 个载荷文件**；全量在
     载荷自带的 manifests\files.sha256 里（50 639 行，排除 manifests\
     目录自身）。要一次跑完全量校验用 start.cmd --verify。
     校验和只证明完整性，不建立信任。


6. 版本声明
----------------------------------------------------------------
  * 产物文件名里的 0.0.1-rc.6 是一个打包标签，同时等于安装包的版本。
  * 仓库 package.json 的 version 仍是 0.0.0，本包没有改动它。
  * 预发布：不代表版本已冻结，不代表已通过正式发布门禁。
  * 不得据此宣称「可发布」「已达发布标准」「跨平台可用」
    「许可已合规」。


7. 包内新增了什么（相对载荷）
----------------------------------------------------------------
  AIDrivenNetDefense.exe        载荷自带，**不是本包新增**（桌面壳）
  start.cmd                     启动器入口（stdio worker，ASCII 批处理）
  stop.cmd                      停止入口
  README-快速开始.txt            本文件
  SHA256SUMS                    关键文件校验清单
  launcher\aidnd-launch.mjs     启动器主程序（用内嵌 node 运行）
  launcher\aidnd-stop.mjs       停止程序
  launcher\lib\attempt.mjs      attempt 环境准备（复用载荷的 profile）
  launcher\lib\version.mjs      版本/标签常量

其余目录（app\ apps\ console\ dsh-home\ launch\ manifests\ rules\
runtime\ 与 AIDrivenNetDefense.exe、bundle.json、README-BUNDLE.md）
全部是载荷原样内容，未改动一个字节。载荷里已经包含 daemon 与 console，
所以它们不是本包新增的。

启动器启动时会重新核对载荷自带的
app\node_modules\plugins\dsh-defense-profile\approved-hashes.json，
profile.json 哈希不符则拒绝启动。


8. 运行时会写哪些位置
----------------------------------------------------------------
  <解压目录>\run\              状态、端口、launcher 与 worker 日志
  %TEMP%\AIDriven-NetDefense\  每次启动的临时 attempt 树，
                               包含 worker 自己的 HOME/TMP/profile 副本；
                               stop.cmd 会删除它，删不掉会如实报错。
  %LOCALAPPDATA%\AIDrivenNetDefense\
                               桌面壳的数据目录（settings、shell\runtime.json、
                               事件库）。这是壳自己的约定，与安装版一致。
  不写：注册表、ProgramData、Program Files、系统服务、
        开始菜单、开机自启。

  卸载方式：退出桌面壳、停止 launcher，然后直接删除整个解压目录即可；
  需要连数据一起清掉时，再删上面那个 %LOCALAPPDATA% 目录。


9. 已知限制
----------------------------------------------------------------
  * 未签名（本包按指令不签名）。首次运行会有「未知发布者」提示。
  * 仅 Windows x64；Linux/macOS 未打包。
  * 更新检查未接线；本版不会自动更新，也不会提示有新版本。
  * daemon 只跑过 mock 采集模式，real 模式下的 /healthz: ok 未观测。
  * 托盘菜单的鼠标点击这一跳未自动化验证（用的是等价的
    WM_COMMAND 路径）。
  * 强制关闭 start.cmd 的控制台窗口不会走优雅退出；此时 worker 会因
    管道断开自行退出，但 attempt 树可能残留，建议用 stop.cmd。
  * 若解压目录位于只读介质，run\ 无法创建，启动会失败并报错。
  * 安装耗时参考（安装版）：约 8–12 分钟，主要花在解压 486 MB 与复制。
