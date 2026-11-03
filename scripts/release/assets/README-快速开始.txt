AIDriven NetDefense（网域智防）· Windows x64 便携预览包
================================================================

版本标签 : 0.0.1-rc.1（预发布打包标签，仅用于产物命名）
产品版本 : 0.0.0（仓库版本未变更）
平台     : Windows x64
作者     : PT-dove
打包时间 : 见 SHA256SUMS 旁的 status 记录

【重要】0.0.1-rc.1 是「预发布」标签，只用来给这个 zip 命名。
它不是版本冻结声明，不代表 0.0.1 已发布、已签收或已达到发布标准。
正式版本在完整门禁通过并由维护者明确批准后另行冻结。


1. 这是什么
----------------------------------------------------------------
把本仓库 M8 阶段已构建、已审计的 win32-x64 运行时载荷（v13，
relocatable）打成一个可直接解压运行的 zip，另外补一个启动器、
一个停止脚本和一份校验清单。

包内 payload 与构建产物逐字节一致：本包没有重建、没有重新编译、
没有改动载荷里的任何文件。


2. 这不是什么
----------------------------------------------------------------
  * 不是安装器：不解压到 Program Files，不写注册表，不建开始菜单，
    不注册 Windows 服务，不写 ProgramData，不做卸载项。
  * 未签名：没有代码签名、没有信任根、没有签名者校验。
  * 没有升级器：没有增量更新、没有回滚。
  * 只有 Windows x64 一种形态。
  * 没有真实模型凭据、没有模型权重、没有 API Key。
  * 载荷内没有 daemon / broker / sandbox-launcher / 图形界面。
    启动器拉起的是载荷自带的 worker（stdio 协议），它能正常
    initialize 并挂载 20 个已审阅插件（连 loader 自身共 21 条挂载项），
    但真正的模型请求会失败——因为单机没有 broker。这是预期行为，
    不是本包的缺陷。


3. 系统要求
----------------------------------------------------------------
  * Windows 10/11 x64（本包只在 Windows 11 x64 上实测过；
    Windows 10 未验证，不得据此宣称支持）。
  * 解压后约 431 MiB，另需临时目录约 5 MiB（attempt 树）。
  * 不需要安装 Node.js——运行时已内嵌（v24.20.0）。
  * 不需要外网。启动器只监听 127.0.0.1。


4. 快速开始
----------------------------------------------------------------
  1) 解压整个 zip 到任意本地目录。
     路径可以含空格和中文，例如：
       D:\测试 目录\AIDriven NetDefense
     不要只解压一部分文件，也不要解开后把子目录单独搬走。

  2) 双击 start.cmd（或在命令行运行）。
     它会打印一行：
       READY http://127.0.0.1:<端口>/healthz
     窗口保持打开即代表服务在跑；日志在同一目录的 run\ 下。

  3) 验证健康端点（另开一个窗口）：
       curl http://127.0.0.1:<端口>/healthz
     返回 HTTP 200，JSON 里 "status": "ok" 表示 launcher 与 worker
     都正常；worker 掉线时同一个地址返回 503 且 status 为 "degraded"。

  4) 停止：
       stop.cmd
     它会请求 launcher 优雅退出、等 worker 一起退出、清掉临时
     attempt 树，并打印 launcherGone / workerGone / residual。
     看到 "residual": "none" 即表示无残留进程。

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
  1) 先校验 zip 本身：把随包的 <zip 名>.sha256 与下面命令的输出比对，
     Windows 可用 PowerShell：
       (Get-FileHash .\<zip 名> -Algorithm SHA256).Hash
     两串相同即压缩包在传输中未损坏。
  2) 再校验包内关键文件：进入解压目录执行（certutil 逐行或
     PowerShell 均可），核对 SHA256SUMS 里每一行的哈希；
     本包启动器每次启动都会自动做这件事，哈希不符会直接拒绝启动
     （退出码 93）。
  3) SHA256SUMS 覆盖的是包内关键文件（start.cmd / stop.cmd /
     launcher\ 下的脚本 / launch\ 三个产物 / bundle.json /
     manifests\files.sha256 / runtime\node\node.exe），
     不覆盖全部 47107 个载荷文件；要全量校验请用 start.cmd --verify。
     校验和只证明完整性，不建立信任。


6. 版本声明
----------------------------------------------------------------
  * 产物文件名里的 0.0.1-rc.1 只是一个打包标签。
  * 仓库 package.json 的 version 仍是 0.0.0，本包没有改动它。
  * 预发布：不代表版本已冻结，不代表已通过正式发布门禁。
  * 不得据此宣称「可发布」「已达发布标准」「跨平台可用」
    「许可已合规」。


7. 包内新增了什么（相对载荷）
----------------------------------------------------------------
  start.cmd                     启动器入口（ASCII 批处理）
  stop.cmd                      停止入口
  README-快速开始.txt            本文件
  SHA256SUMS                    关键文件校验清单
  launcher\aidnd-launch.mjs     启动器主程序（用内嵌 node 运行）
  launcher\aidnd-stop.mjs       停止程序
  launcher\lib\attempt.mjs      attempt 环境准备（复用载荷的 profile）
  launcher\lib\version.mjs      版本/标签常量

其余目录（app\ dsh-home\ launch\ manifests\ runtime\ 与
bundle.json、README-BUNDLE.md）全部是载荷原样内容，未改动一个字节。

启动器启动时会重新核对载荷自带的
app\node_modules\plugins\dsh-defense-profile\approved-hashes.json，
profile.json 哈希不符则拒绝启动。


8. 运行时会写哪些位置
----------------------------------------------------------------
  <解压目录>\run\              状态、端口、launcher 与 worker 日志
  %TEMP%\AIDriven-NetDefense\  每次启动的临时 attempt 树，
                               包含 worker 自己的 HOME/TMP/profile 副本；
                               stop.cmd 会删除它，删不掉会如实报错。
  不写：注册表、ProgramData、Program Files、系统服务、
        开始菜单、开机自启。

  卸载方式：停止后直接删除整个解压目录即可。


9. 已知限制
----------------------------------------------------------------
  * 未签名（本包按指令不签名）。
  * 仅 Windows x64；Linux/macOS 未打包。
  * worker 只能跑到 stdio 阶段；模型请求必然失败（无 broker）。
  * 强制关闭 start.cmd 的控制台窗口不会走优雅退出；此时 worker 会因
    管道断开自行退出，但 attempt 树可能残留，建议用 stop.cmd。
  * 若解压目录位于只读介质，run\ 无法创建，启动会失败并报错。
