# phone-control

在 Codex 里用一句话操控安卓手机:一句 `mobile_connect({})` 自动发现局域网里的无线调试设备,之后按 UI 节点序号点击、复查,而不是对着截图猜坐标。

底层是一套**只依赖 Node 内置模块**的 ADB 引擎,与宿主解耦——同一份 `lib/` 可以同时被 Codex Skill 和其它宿主复用,不会出现两套引擎抢同一个 adb server。

> **这些工具会真实操作你的设备。** 点击、滑动、卸载应用、`pm clear` 清数据都会立即生效,没有二次确认。请先读完「安全边界」一节。

## 它是什么

两层结构,各管各的:

| 层 | 文件 | 职责 |
|---|---|---|
| 引擎 | `lib/adb.js`、`lib/uitree.js`、`lib/commands.js`、`lib/paths.js` | 调用 adb、解析设备、mDNS 发现无线调试服务、解析 UI 树、转义命令。只 import `node:*` |
| 适配层 | `mcp-server.mjs` | 把 MCP 的 `tools/list`、`tools/call` 翻译成对引擎的调用。零依赖 |

工具通过 Node 进程调用 adb,不做 shell 拼接。

```text
phone-control/
├── lib/
│   ├── adb.js           # adb 调用、设备解析、mDNS 发现、截图、输入
│   ├── uitree.js        # UI 树解析与精简
│   ├── commands.js      # 命令转义
│   ├── paths.js         # 路径解析(以包根为锚点,不依赖 cwd)
│   └── phone-ocr.ps1    # 可选:Windows 内置 OCR,认屏幕上的中文
├── mcp-server.mjs       # Codex / MCP 适配层
├── SKILL.md             # Codex 使用规范(装进 skills 目录后自动生效)
├── config.example.toml  # Codex MCP 注册模板
└── package.json
```

## 环境要求

- **Node.js 20+**
- **adb**(Android SDK Platform-Tools 37.0.1+,需自行下载)。本仓库**不附带** `platform-tools/`,它受 Google 的 SDK 许可约束。
- **Windows**:目前只有 Windows 实测过(自带 adb 路径解析、`lib/phone-ocr.ps1` 用 Windows 内置 OCR)。macOS / Linux 未支持。
- 手机端 **Android 11+**(无线调试从 Android 11 开始提供)

## 安装

1. 克隆本仓库,并准备好 `adb`:

   ```powershell
   git clone https://github.com/sheear/phone-control.git
   # adb 三种来源任选其一:
   #   a) 解压 platform-tools 到 phone-control/platform-tools/
   #   b) 把 platform-tools 加进 PATH
   #   c) 用环境变量 DSH_MOBILE_ADB 直接指到 adb.exe
   ```

2. 把 MCP server 注册进 `~/.codex/config.toml`:

   ```toml
   [mcp_servers.phone-control]
   command = "node"
   args = ["C:/path/to/phone-control/mcp-server.mjs"]
   ```

   更多选项(超时、工作目录、工具白名单/黑名单)见 [`config.example.toml`](config.example.toml)。

3. 可选:把 `SKILL.md` 放到 `~/.codex/skills/phone-control/SKILL.md`,让 Codex 自动知道该怎么用这些工具。

4. 重启 Codex 会话。

## 用法

手机端:设置 → 开发者选项 → 打开**无线调试**(需 Android 11 及以上)。

**不用手抄 IP 和端口。** 无线调试会把服务广播到局域网,`mobile_connect({})` 用 mDNS 自动发现并连接。

首次配对(只需一次):手机上点「使用配对码配对设备」,把 6 位配对码给出来,然后:

```json
mobile_connect({ "pairCode": "123456" })
```

配对地址会自动发现。注意配对广播只在那个弹窗开着时才存在,配对码几分钟就过期。

日常重连:手机重启、切网、关过无线调试之后,`mobile_connect({})` 就行。

也可以用 USB 首次连接:开 USB 调试 → 插线 → 手机上允许调试授权。

### 操作界面的标准流程

1. `mobile_app({action:"current"})` —— 确认当前在哪个界面
2. `mobile_ui({})` —— 拿节点列表和坐标
3. `mobile_tap({nodeIndex: 12})` —— 点目标节点中心
4. `mobile_ui({})` —— 复查结果

**优先用 `mobile_ui` 的节点序号和中心点,不要对着截图目测坐标。** `mobile_screenshot` 只存盘并返回路径,要看图得再读那个文件。

### 工具一览

`mobile_connect` `mobile_status` `mobile_ui` `mobile_screenshot` `mobile_tap` `mobile_swipe` `mobile_type` `mobile_key` `mobile_app` `mobile_shell` `mobile_pull` `mobile_push`

## 安全边界

- `mobile_shell` 的权限等于 adb 的权限:能改系统设置、卸载应用、`pm clear` 清数据,**没有二次确认**。只想点击和读屏的话,在配置里用 `disabled_tools = ["mobile_shell"]` 把它关掉。
- **不要让模型去点「飞行模式」**:那会断掉手机网络,如果请求本身依赖手机,可能把自己弄断线。
- **手机截图属于敏感内容。** 这套工具的设计约定是:优先读 UI 节点而不是截图;确实要截图时,看一眼就够,看完立刻删除,不要另存到长期位置。

## 已知限制

- `mobile_type` 只能输 ASCII 可见字符(空格、字母、数字、常见符号)。中文等非 ASCII 字符会被拒绝,因为 `adb input text` 传不了 Unicode;要输中文得另想办法(如 ADBKeyboard)。
- 应用私有目录(`/data/data` 等)没有 root 读不到。
- 无线调试状态 `unauthorized`:需要在手机上重新确认调试授权,或重新配对。

## 排错

| 现象 | 处理 |
|---|---|
| 没有设备 | 手机和电脑要在同一局域网;确认「无线调试」页面处于打开状态(mDNS 广播依赖它) |
| 状态 `unauthorized` | 手机上重新确认调试授权,或重新配对 |
| 配对码无效 | 配对码一次性、几分钟过期,重新点开配对弹窗再来 |
| `uiautomator dump` 没有返回层次结构 | 界面在动画中,或该界面禁止 dump;重试或改用截图 |
| 截图报错 | 息屏或 DRM 保护界面,先 `mobile_key({key:"WAKEUP"})` |
| 工具消失 | 重启 Codex 会话 |

## 许可

MIT,见 [LICENSE](LICENSE)。仓库不包含 Android SDK Platform-Tools;adb 受 Google 的 Android SDK 许可约束。
