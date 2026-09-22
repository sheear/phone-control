---
name: phone-control
description: 用电脑操控安卓手机——通过 ADB(USB 线或无线调试)连接手机,执行点击、滑动、输入文字、截图、装应用、跑 shell 等操作。当用户说「操控手机/控制手机/手机自动化/连手机/无线调试/adb 连手机」「帮我在手机上点一下/输入/截个图」,或需要查看、操作手机界面时使用。
metadata:
  short-description: ADB 手机操控与无线调试
---

# 用电脑操控手机

Codex 这边是一个薄适配层,底下是同一仓库里的引擎,不另起一套:

- 引擎:`lib/adb.js`(adb 调用、设备解析、mDNS 发现)、`lib/uitree.js`(UI 树解析)、`lib/commands.js`(命令转义)只依赖 Node 内置模块、宿主无关。
- Codex 适配层:`mcp-server.mjs`,零依赖,只把 MCP 的 tools/* 翻译成对上面 lib 的调用。
- 注册位置:`~/.codex/config.toml` 的 `[mcp_servers.phone-control]`,命令是 `node` 加这个 mjs。字段含义见仓库里的 `config.example.toml`。
- adb:按 `lib/paths.js` 的候选顺序解析——`DSH_MOBILE_ADB` 环境变量 → 仓库内 `platform-tools/`、`.tools/platform-tools/` → 当前工作目录下的同名目录 → PATH。所以仓库里放了 platform-tools 就能直接用,没放也不依赖启动目录。

改引擎的 `lib/` 会同时影响所有复用它的话,改完重启 Codex 会话生效。同一个 adb server(5037)不要同时跑互相冲突的操作。

## 连接手机

手机端:开发者选项 → 打开「无线调试」(需 Android 11 及以上)。

**不用手抄 IP 和端口。** 无线调试会把服务广播到局域网,`mobile_connect({})` 用 mDNS 自动发现并连接。

首次配对(只需一次):手机上点「使用配对码配对设备」,把 6 位配对码给出来,然后调 `mobile_connect({ pairCode: "123456" })` —— 配对地址会自动发现。注意配对广播只在那个弹窗开着时才存在。

日常重连:手机重启、切网、关过无线调试之后,`mobile_connect({})` 就行。

也可以用 USB 首次连接:开 USB 调试 → 插线 → 手机上允许调试授权。

## 工具

`mobile_connect`、`mobile_status`、`mobile_ui`、`mobile_screenshot`、`mobile_tap`、`mobile_swipe`、`mobile_type`、`mobile_key`、`mobile_app`、`mobile_shell`、`mobile_pull`、`mobile_push`

操作界面的标准流程:

1. `mobile_app({action:"current"})` 确认当前在哪个界面
2. `mobile_ui({})` 拿节点列表和坐标
3. `mobile_tap({nodeIndex: 12})` 点目标节点中心
4. 再 `mobile_ui({})` 复查结果

优先用 `mobile_ui` 的节点序号和中心点,不要对着截图目测坐标。`mobile_screenshot` 只存盘返回路径,要看图得再读那个文件。

## 截图用完即删

手机截图属于敏感内容,不要留在磁盘上:

- 看屏幕优先用 `mobile_ui` 读界面节点,不截图。
- 确实要截图时(`mobile_screenshot`),看一眼就够,看完立刻删掉那个文件,不要让截图留到会话结束。
- 不要把截图另存到 outputs、桌面或任何长期位置,也不要复制出多份。
- 手机上产生的临时截图(如 /sdcard/xxx.png)传完就删。

## 已知限制

- `mobile_type` 只能输 ASCII 可见字符;中文传不了,这是 `adb input text` 的限制,需要中文得另想办法。
- `mobile_shell` 的权限等于 adb 的权限:能改系统设置、卸载应用、`pm clear` 清数据,没有二次确认,危险命令会真的生效。只想点击和读屏的话,在 `config.toml` 里用 `disabled_tools = ["mobile_shell"]` 关掉它。
- **不要让模型去点「飞行模式」**:那会断掉手机网络,如果请求本身依赖手机,可能把自己弄断线。
- 应用私有目录(`/data/data` 等)没有 root 读不到。

## 排错

- 没有设备:手机和电脑要在同一局域网;确认「无线调试」页面处于打开状态(mDNS 广播依赖它)。
- 状态 `unauthorized`:手机上重新确认调试授权,或者重新配对。
- 配对码无效:配对码是一次性的、几分钟就过期,重新点开配对弹窗再来。
- `uiautomator dump` 没有返回层次结构:界面在动画中,或该界面禁止 dump;重试或改用截图。
- 截图报错:息屏或 DRM 保护界面,先 `mobile_key({key:"WAKEUP"})`。
- 工具消失,或改完 lib 没生效:重启 Codex 会话。

仓库里还有个 `lib/phone-ocr.ps1`,用 Windows 内置 OCR 引擎认屏幕上的中文,零依赖不联网;Codex 侧目前没把它包成工具,需要时可直接用命令行调。
