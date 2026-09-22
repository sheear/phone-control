#!/usr/bin/env node
/**
 * phone-control —— Codex 侧的手机操控 MCP 服务。
 *
 * 这里只做「协议翻译」：把 MCP 的 tools/list、tools/call 转成对 lib/ 那套
 * 引擎的调用。adb 传输、设备解析、mDNS 发现、UI 树解析、命令转义全部复用
 * lib/ 下的既有实现，不在 Codex 这边另起一套 adb 引擎（两套引擎会同时驱动
 * 同一个 adb server）。
 *
 * 引擎位置默认就是本文件所在的目录（lib/ 的上一级），可用 DSH_MOBILE_ADB_PLUGIN 覆盖；
 * adb 路径用 DSH_MOBILE_ADB 覆盖，不设时由 lib/paths.js 按候选顺序自动查找。
 */
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = process.env.DSH_MOBILE_ADB_PLUGIN ?? dirname(fileURLToPath(import.meta.url))
const libUrl = (file) => pathToFileURL(join(PLUGIN_ROOT, 'lib', file)).href

let adb
let parseHierarchy
let simplify
let buildTapCommand
let buildSwipeCommand
let escapeForInputText
let findUntransportableChars

try {
  adb = await import(libUrl('adb.js'))
  ;({ parseHierarchy, simplify } = await import(libUrl('uitree.js')))
  ;({ buildTapCommand, buildSwipeCommand, escapeForInputText, findUntransportableChars } = await import(libUrl('commands.js')))
} catch (err) {
  process.stderr.write(`phone-control: 无法加载引擎库 ${PLUGIN_ROOT}\\lib\n${err?.message ?? err}\n`)
  process.exit(1)
}

const adbPath = adb.resolveAdbPath(process.env.DSH_MOBILE_ADB)
const screenshotDir = adb.resolveScreenshotDir()

/** 解析目标设备：显式 serial > 唯一在线设备。 */
const target = async (serial) => (await adb.resolveSerial(adbPath, serial)).serial

const SERIAL = { type: 'string', description: '目标设备序列号；只有一台在线设备时可省略。' }

const tools = [
  {
    name: 'mobile_connect',
    description:
      '连接或配对一台 Android 手机（无线调试 / ADB over TCP）。四种用法：① 带 pairHostPort + pairCode 做首次配对；② 带 hostPort 连接指定端点；③ 都带则先配对再连接；④ 什么都不带时用 mDNS 自动发现局域网里的无线调试设备并直接连接。手机端需先打开「设置 → 开发者选项 → 无线调试」。',
    properties: {
      hostPort: { type: 'string', description: '连接地址，形如 192.168.1.5:5555（无线调试页「IP 地址和端口」）。' },
      pairHostPort: { type: 'string', description: '配对地址，形如 192.168.1.5:37123（「使用配对码配对设备」弹窗里的地址，端口与连接地址不同）。省略时从 mDNS 自动发现。' },
      pairCode: { type: 'string', description: '手机弹出的 6 位配对码。' },
      noDiscover: { type: 'boolean', description: 'true 时关闭 mDNS 自动发现，只按显式参数或当前设备列表处理。' },
    },
    required: [],
    async run(args) {
      const steps = []
      let discovered = {}
      const discover = args.noDiscover
        ? async () => ({ pairing: null, connect: null })
        : () => adb.discoverWireless(adbPath)

      if (args.pairCode) {
        let pairAddr = args.pairHostPort
        if (!pairAddr) {
          const d = await discover()
          discovered = d
          pairAddr = d.pairing
          if (!pairAddr) {
            return '没有在 mDNS 里发现配对服务（_adb-tls-pairing）。请在手机上点开「使用配对码配对设备」弹窗后重试——该广播只在弹窗打开时出现。'
          }
          steps.push(`mDNS 发现配对地址：${pairAddr}`)
        }
        const r = await adb.pair(adbPath, pairAddr, args.pairCode)
        steps.push(`配对 ${pairAddr}：${r.text}`)
        if (!r.ok) return steps.join('\n')
      }

      let connectAddr = args.hostPort
      if (!connectAddr && !args.noDiscover) {
        const d = discovered.connect ? discovered : await discover()
        discovered = d
        connectAddr = d.connect
        if (connectAddr) steps.push(`mDNS 发现连接地址：${connectAddr}`)
      }
      if (connectAddr) {
        const r = await adb.connect(adbPath, connectAddr)
        steps.push(`连接 ${connectAddr}：${r.text}`)
      }

      const devices = await adb.listDevices(adbPath)
      const rendered = devices.map((d) => `${d.serial}  state=${d.state}${d.model ? `  model=${d.model}` : ''}`)
      if (rendered.length === 0) {
        steps.push('当前没有设备。检查：手机与电脑同一局域网、无线调试已开启、是否配对过（未配对时连接会被拒绝）。')
        if (!args.noDiscover && !discovered.connect) {
          steps.push('mDNS 也没发现任何无线调试广播：确认手机「无线调试」页面处于打开状态。')
        }
      } else {
        steps.push(...rendered)
      }
      return steps.join('\n')
    },
  },

  {
    name: 'mobile_status',
    description:
      '查看当前无线连接状态与手机基础信息（型号、Android 版本、SDK、分辨率、DPI）。没有设备在线时，仍会用 mDNS 列出局域网里正在广播的无线调试地址，便于下一步 mobile_connect。',
    properties: { serial: SERIAL },
    required: [],
    async run(args) {
      const devices = await adb.listDevices(adbPath)
      const rendered = devices.map((d) => `${d.serial}  state=${d.state}`)
      const online = devices.filter((d) => d.state === 'device')

      if (online.length !== 1 && !args.serial) {
        const lines = rendered.length ? rendered : ['（无设备在线）']
        try {
          const d = await adb.discoverWireless(adbPath)
          if (d.pairing) lines.push(`mDNS 配对地址：${d.pairing}`)
          if (d.connect) lines.push(`mDNS 连接地址：${d.connect}`)
        } catch {
          // mDNS 不可用不影响状态查询本身
        }
        return lines.join('\n')
      }

      const serial = await target(args.serial)
      const info = await adb.deviceInfo(adbPath, serial)
      return JSON.stringify({ serial, devices: rendered, ...info }, null, 2)
    },
  },

  {
    name: 'mobile_ui',
    description:
      '读取当前界面的 UI 节点树（uiautomator dump），返回每个元素的位置与属性。这是点击定位的主要依据，优先用它而不是猜坐标。节点字段：i=序号（可传给 mobile_tap 的 nodeIndex）、cls=控件类、text/desc=文字、id=resource-id、b=[x1,y1,x2,y2] 边界、c=[cx,cy] 中心点，以及 clickable/scrollable/checked/focused/longClickable 等标记。',
    properties: {
      serial: SERIAL,
      all: { type: 'boolean', description: 'true 时返回全部节点（含纯容器），排查布局用；默认只返回有文字或可交互的节点。' },
      maxNodes: { type: 'integer', description: '最多返回多少节点，默认 400，防止输出过长。' },
      pkg: { type: 'string', description: '只保留该包名的节点，例如 com.android.settings。' },
    },
    required: [],
    async run(args) {
      const serial = await target(args.serial)
      const xml = await adb.dumpUi(adbPath, serial, { timeout: 60000 })
      const { nodes } = parseHierarchy(xml)
      const scoped = args.pkg ? nodes.filter((n) => n.package === args.pkg) : nodes
      const r = simplify(scoped, { all: args.all === true, maxNodes: args.maxNodes ?? 400 })
      return JSON.stringify({
        serial,
        total: r.total,
        shown: r.shown,
        ...(r.truncated ? { truncated: true } : {}),
        nodes: r.nodes,
      })
    },
  },

  {
    name: 'mobile_screenshot',
    description:
      '截取当前屏幕并存成 PNG 文件，返回文件路径。本工具只返回路径，不直接回传图像；要看图请接着读取该路径。UI 树看不懂布局时用它做视觉核对。',
    properties: {
      serial: SERIAL,
      path: { type: 'string', description: '保存路径；省略则存到工作区的 _mobile_shots/ 下并按时间命名。' },
    },
    required: [],
    async run(args) {
      const serial = await target(args.serial)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const file = args.path ?? join(screenshotDir, `shot-${stamp}.png`)
      const r = await adb.screenshot(adbPath, serial, file)
      return `截图已保存：${r.path}（${r.width}x${r.height}, ${r.bytes} 字节）`
    },
  },

  {
    name: 'mobile_tap',
    description: '点击屏幕坐标或指定节点中心。优先用 mobile_ui 拿到的节点中心点 c=[cx,cy]，而不是自己目测坐标。',
    properties: {
      x: { type: 'integer', description: '横坐标（与 y 同时给出）。' },
      y: { type: 'integer', description: '纵坐标（与 x 同时给出）。' },
      nodeIndex: { type: 'integer', description: 'mobile_ui 返回的节点序号 i，自动点到该节点中心（与 x/y 二选一）。' },
      serial: SERIAL,
    },
    required: [],
    async run(args) {
      const serial = await target(args.serial)
      let x = args.x
      let y = args.y
      let label
      if (args.nodeIndex !== undefined) {
        const xml = await adb.dumpUi(adbPath, serial, { timeout: 60000 })
        const { nodes } = parseHierarchy(xml)
        const hit = nodes.find((n) => n.index === args.nodeIndex)
        if (!hit || hit.cx === undefined) throw new Error(`节点序号 ${args.nodeIndex} 不存在或没有有效边界，请重新调用 mobile_ui`)
        x = hit.cx
        y = hit.cy
        label = hit.text || hit['content-desc'] || hit['resource-id'] || hit.class
      }
      if (x === undefined || y === undefined) throw new Error('需要 x 与 y，或提供 nodeIndex')
      await adb.shell(adbPath, serial, buildTapCommand(x, y))
      return `已点击 (${Math.round(x)}, ${Math.round(y)})${label ? ` —— ${label}` : ''}`
    },
  },

  {
    name: 'mobile_swipe',
    description: '滑动 / 滚动。上下滑动列表就用它，例如从屏幕中下部滑到上部。',
    properties: {
      x1: { type: 'integer', description: '起点 x。' },
      y1: { type: 'integer', description: '起点 y。' },
      x2: { type: 'integer', description: '终点 x。' },
      y2: { type: 'integer', description: '终点 y。' },
      durationMs: { type: 'integer', description: '滑动时长（毫秒），默认 300；慢滑更接近人手。' },
      serial: SERIAL,
    },
    required: ['x1', 'y1', 'x2', 'y2'],
    async run(args) {
      const serial = await target(args.serial)
      const d = args.durationMs ?? 300
      await adb.shell(adbPath, serial, buildSwipeCommand(args.x1, args.y1, args.x2, args.y2, d))
      return `已滑动 (${args.x1}, ${args.y1}) → (${args.x2}, ${args.y2})`
    },
  },

  {
    name: 'mobile_type',
    description:
      '向当前聚焦的输入框输入文字。只能输入 ASCII 可见字符（空格、字母、数字、常见符号）。中文等非 ASCII 字符会被拒绝，因为 adb input text 传不了 Unicode——需要输入中文请改用其他途径（如 ADBKeyboard）。',
    properties: {
      value: { type: 'string', description: '要输入的文字，仅限 ASCII 可见字符。' },
      serial: SERIAL,
    },
    required: ['value'],
    async run(args) {
      const value = String(args.value)
      const bad = findUntransportableChars(value)
      if (bad.length) throw new Error(`input text 无法传输非 ASCII 字符：${bad.join('')}。请改用其他输入方式。`)
      const serial = await target(args.serial)
      await adb.shell(adbPath, serial, `input text "${escapeForInputText(value)}"`)
      return `已输入：${value}`
    },
  },

  {
    name: 'mobile_key',
    description: '发送按键事件。常用：BACK(返回)、HOME(桌面)、ENTER、DEL(退格)、APP_SWITCH(最近任务)、WAKEUP(点亮)、SLEEP(息屏)、POWER。',
    properties: {
      key: { type: 'string', description: '按键名，如 BACK / HOME / ENTER / DEL / APP_SWITCH / WAKEUP / POWER。' },
      serial: SERIAL,
    },
    required: ['key'],
    async run(args) {
      const key = String(args.key).toUpperCase()
      if (!/^[A-Z0-9_]+$/.test(key)) throw new Error(`按键名不合法：${args.key}`)
      const serial = await target(args.serial)
      await adb.shell(adbPath, serial, `input keyevent ${key}`)
      return `已发送按键 ${key}`
    },
  },

  {
    name: 'mobile_app',
    description: '启动应用、读取当前前台应用、列出已安装包。action=launch 需要 pkg；action=current 读当前界面所属包；action=list 列出已安装包（可带 filter 关键词）。',
    properties: {
      action: { type: 'string', description: 'launch | current | list' },
      pkg: { type: 'string', description: 'action=launch 时的包名，例如 com.android.settings。' },
      filter: { type: 'string', description: 'action=list 时的关键词过滤。' },
      serial: SERIAL,
    },
    required: ['action'],
    async run(args) {
      const serial = await target(args.serial)
      const action = String(args.action).toLowerCase()
      if (action === 'launch') {
        if (!args.pkg) throw new Error('action=launch 需要提供 pkg')
        await adb.shell(adbPath, serial, `monkey -p ${args.pkg} -c android.intent.category.LAUNCHER 1`)
        return `已启动 ${args.pkg}`
      }
      if (action === 'current') {
        const out = await adb.shell(adbPath, serial, 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"')
        return out.trim() || '(读不到当前焦点窗口)'
      }
      if (action === 'list') {
        const out = await adb.shell(adbPath, serial, 'pm list packages')
        const pkgs = out.split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean)
        const filtered = args.filter ? pkgs.filter((p) => p.includes(args.filter)) : pkgs
        return filtered.join('\n')
      }
      throw new Error(`未知 action：${args.action}（支持 launch | current | list）`)
    },
  },

  {
    name: 'mobile_shell',
    description:
      '在手机上执行任意 shell 命令并返回输出。用于读系统状态、改系统设置、拉日志等 adb shell 能做的一切。危险命令同样会生效——不要执行会让设备失联或丢数据的操作。',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令，在手机的 /system/bin/sh 下运行。' },
      timeoutMs: { type: 'integer', description: '超时毫秒数，默认 30000。' },
      serial: SERIAL,
    },
    required: ['command'],
    async run(args) {
      const serial = await target(args.serial)
      const out = await adb.shell(adbPath, serial, String(args.command), { timeout: args.timeoutMs ?? 30000 })
      return out.trimEnd() || '(命令无输出)'
    },
  },

  {
    name: 'mobile_pull',
    description: '把手机上的文件 / 目录拉到电脑。注意 Android 应用私有目录（/data/data 等）没有 root 读不到。',
    properties: {
      remote: { type: 'string', description: '手机上的路径，例如 /sdcard/Download/a.png。' },
      local: { type: 'string', description: '保存到电脑的路径。' },
      serial: SERIAL,
    },
    required: ['remote', 'local'],
    async run(args) {
      const serial = await target(args.serial)
      const out = await adb.runAdbText(adbPath, ['-s', serial, 'pull', String(args.remote), String(args.local)], { timeout: 300000 })
      return out.trim()
    },
  },

  {
    name: 'mobile_push',
    description: '把电脑上的文件推到手机。推 /sdcard 一般不需要 root。',
    properties: {
      local: { type: 'string', description: '电脑上的文件路径。' },
      remote: { type: 'string', description: '手机上的目标路径，例如 /sdcard/Download/a.png。' },
      serial: SERIAL,
    },
    required: ['local', 'remote'],
    async run(args) {
      const serial = await target(args.serial)
      const out = await adb.runAdbText(adbPath, ['-s', serial, 'push', String(args.local), String(args.remote)], { timeout: 300000 })
      return out.trim()
    },
  },
]

const toolList = tools.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: {
    type: 'object',
    properties: t.properties,
    required: t.required ?? [],
  },
}))

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

async function handle(msg) {
  const { id, method, params } = msg

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'phone-control', version: '1.0.0' },
      },
    }
  }

  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: toolList } }

  if (method === 'tools/call') {
    const tool = tools.find((t) => t.name === params?.name)
    if (!tool) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `未知工具：${params?.name}` }], isError: true } }
    }
    try {
      const text = await tool.run(params?.arguments ?? {})
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }] } }
    } catch (err) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `错误：${err?.message ?? String(err)}` }], isError: true } }
    }
  }

  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${method}` } }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  let msg
  try {
    msg = JSON.parse(s)
  } catch {
    return
  }
  if (msg.id === undefined) return // 通知，无需回应
  handle(msg)
    .then(send)
    .catch((err) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err?.message ?? err) } }))
})

rl.on('close', () => process.exit(0))

process.stderr.write(`phone-control MCP 已启动（adb: ${adbPath}）\n`)
