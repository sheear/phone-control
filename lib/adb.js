/**
 * ADB 传输层：进程调用、无线配对/连接、设备解析、UI 树、截图、输入。
 * 只依赖 node 内置模块，便于在 workspace 里独立测试。
 */
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ADB_BIN, PACKAGE_ROOT, resolveAdbPath, resolveScreenshotDir } from './paths.js'

// 路径解析集中在 paths.js（不依赖 process.cwd()）；此处转出便于调用方只 import adb.js。
export { ADB_BIN, PACKAGE_ROOT, resolveAdbPath, resolveScreenshotDir }

/**
 * 跑一次 adb 并把 stdout 当二进制收回来。
 * @param {string} adb adb 路径
 * @param {string[]} args 参数数组（execFile 不经 shell，无需转义）
 * @param {{timeout?:number, signal?:AbortSignal, binary?:boolean}} [opts]
 * @returns {Promise<{stdout:Buffer, stderr:string, code:number}>}
 */
export function runAdb(adb, args, opts = {}) {
  const { timeout = 30_000, signal } = opts
  return new Promise((resolve) => {
    execFile(
      adb,
      args,
      { timeout, signal, windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const errBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? ''), 'utf8')
        const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8')
        resolve({
          stdout: outBuf,
          stderr: errBuf.toString('utf8'),
          code: err?.code === 'ETIMEDOUT' ? 124 : (err ? (typeof err.code === 'number' ? err.code : 1) : 0),
        })
      },
    )
  })
}

/** 跑一次 adb 并对失败抛错，stdout 按 utf8 文本返回。 */
export async function runAdbText(adb, args, opts = {}) {
  const r = await runAdb(adb, args, opts)
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout.toString('utf8')).trim() || `adb ${args.join(' ')} 退出码 ${r.code}`
    throw new Error(msg)
  }
  return r.stdout.toString('utf8')
}

/** 解析 `adb devices -l` 输出为设备数组。 */
export function parseDevices(text) {
  const devices = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+(device|offline|unauthorized|no permissions|\S+)/.exec(line.trim())
    if (!m || m[1] === 'List') continue
    const rest = line.trim().slice(m[0].indexOf(m[2]) + m[2].length).trim()
    const props = {}
    for (const kv of rest.split(/\s+/)) {
      const i = kv.indexOf(':')
      if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1)
    }
    devices.push({ serial: m[1], state: m[2], model: props.model, product: props.product, device: props.device, transport: props.transport_id })
  }
  return devices
}

/**
 * 去掉指向同一台物理设备的重复条目。
 *
 * Android 11+ 的无线调试会让同一台手机在 adb 里出现两次：一次是 `IP:端口`，
 * 一次是 mDNS 名称（形如 `adb-XXXX-YYYY._adb-tls-connect._tcp`）。两者
 * model/product/device 相同但 serial 不同——不去重的话「只有一台设备」会被
 * 误判成两台，导致所有自动选设备的工具直接报错（真机上实测踩到过）。
 *
 * **只做一件事：把 mDNS 别名并进指纹相同的 IP 条目。**
 * 两个 IP 条目之间永不互相合并——同一个宿舍里出现两台同型号手机是常事，
 * 合并它们意味着可能操控错设备，这个风险远大于少去一次重的收益。
 *
 * @param {Array<object>} devices parseDevices 的输出
 * @returns {Array<object>} 去重后的列表，被合并掉的 serial 记在 aliases 里
 */
export function dedupeDevices(devices) {
  /** 物理设备指纹：型号 + 设备代号 + 产品名，三者都有才算数。 */
  const fingerprint = (d) => {
    const parts = [d.model, d.device, d.product].filter((v) => typeof v === 'string' && v.length > 0)
    return parts.length === 3 ? parts.join('|') : null
  }

  const byFingerprint = new Map()
  const out = []

  // 先收 IP 条目，建立指纹索引
  for (const d of devices) {
    if (d.serial.includes('._adb-tls-')) continue
    const entry = { ...d, aliases: [] }
    out.push(entry)
    const fp = fingerprint(d)
    if (fp !== null && !byFingerprint.has(fp)) byFingerprint.set(fp, entry)
  }

  // 再把 mDNS 条目并进指纹匹配的 IP 条目；匹配不上就作为独立条目保留
  for (const d of devices) {
    if (!d.serial.includes('._adb-tls-')) continue
    const fp = fingerprint(d)
    const target = fp !== null ? byFingerprint.get(fp) : undefined
    if (target !== undefined) target.aliases.push(d.serial)
    else out.push({ ...d, aliases: [] })
  }

  return out
}

/** 列出当前设备（已按物理设备去重）。 */
export async function listDevices(adb, opts = {}) {
  return dedupeDevices(parseDevices(await runAdbText(adb, ['devices', '-l'], opts)))
}

/**
 * 挑一个在线设备：显式指定 > 唯一在线设备 > 报错。
 * 多个在线设备时要求显式指定，避免误操作到别的手机。
 * 显式指定的 serial 也能匹配别名（例如用 mDNS 名称指定同一台手机）。
 */
export async function resolveSerial(adb, requested, opts = {}) {
  const devices = await listDevices(adb, opts)
  if (requested) {
    const hit = devices.find((d) => d.serial === requested || (d.aliases ?? []).includes(requested))
    if (!hit) throw new Error(`设备 ${requested} 不在线。当前：${devices.map((d) => `${d.serial}(${d.state})`).join(', ') || '无'}`)
    if (hit.state !== 'device') throw new Error(`设备 ${requested} 状态为 ${hit.state}，不可用（unauthorized 需要在手机上确认调试授权）`)
    return { serial: hit.serial, devices }
  }
  const online = devices.filter((d) => d.state === 'device')
  if (online.length === 0) {
    const any = devices.length ? devices.map((d) => `${d.serial}(${d.state})`).join(', ') : '无'
    throw new Error(`没有在线设备。当前：${any}。先运行 connect/pair 建立无线连接。`)
  }
  if (online.length > 1) {
    throw new Error(`有 ${online.length} 台在线设备，请用 serial 明确指定：${online.map((d) => d.serial).join(', ')}`)
  }
  return { serial: online[0].serial, devices }
}

/** 配对（Android 11+ 无线调试的 6 位配对码）。 */
export async function pair(adb, hostPort, code, opts = {}) {
  const r = await runAdb(adb, ['pair', hostPort, code], { timeout: 60_000, ...opts })
  const text = (r.stdout.toString('utf8') + r.stderr).trim()
  return { ok: /Successfully paired/i.test(text), text }
}

/** 连接一个已配对的无线调试端点。 */
export async function connect(adb, hostPort, opts = {}) {
  const r = await runAdb(adb, ['connect', hostPort], { timeout: 30_000, ...opts })
  const text = (r.stdout.toString('utf8') + r.stderr).trim()
  return { ok: /connected to/i.test(text) && !/cannot|failed|refused/i.test(text), text }
}

/** 断开（省略 hostPort 则断开全部 TCP 连接）。 */
export async function disconnect(adb, hostPort, opts = {}) {
  const args = hostPort ? ['disconnect', hostPort] : ['disconnect']
  return (await runAdbText(adb, args, opts)).trim()
}

/**
 * 用 adb 内置 mDNS 发现无线调试目标。
 *
 * Android 11+ 的无线调试会把两个服务广播到局域网：
 * `_adb-tls-pairing`（只在配对弹窗打开时出现，端口随机）与
 * `_adb-tls-connect`（常驻，用于日常连接）。
 * 这样就不需要用户手抄 IP 和端口，也不用扫网段。
 *
 * @returns {Promise<{pairing: string|null, connect: string|null, raw: string}>}
 */
/**
 * 解析 `adb mdns services` 的输出，抽出无线调试的配对/连接地址。
 * 纯函数，便于单测；`discoverWireless` 只是它的 IO 外壳。
 * @param {string} raw mdns services 的原始文本
 * @returns {{pairing: string|null, connect: string|null}}
 */
export function parseMdnsServices(raw) {
  let pairing = null
  let connect = null
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const m = /^(\S+)\s+(_adb-tls-pairing\._tcp|_adb-tls-connect\._tcp)\s+(\S+:\d+)/.exec(line.trim())
    if (!m) continue
    if (m[2] === '_adb-tls-pairing._tcp') pairing ??= m[3]
    if (m[2] === '_adb-tls-connect._tcp') connect ??= m[3]
  }
  return { pairing, connect }
}

export async function discoverWireless(adb, opts = {}) {
  const raw = await runAdbText(adb, ['mdns', 'services'], { timeout: 20_000, ...opts })
  return { ...parseMdnsServices(raw), raw: raw.trim() }
}

export async function shell(adb, serial, command, opts = {}) {
  return runAdbText(adb, ['-s', serial, 'shell', command], opts)
}

export async function shellBinary(adb, serial, command, opts = {}) {
  const r = await runAdb(adb, ['-s', serial, 'exec-out', command], opts)
  if (r.code !== 0) throw new Error((r.stderr || '').trim() || `exec-out 退出码 ${r.code}`)
  return r.stdout
}

/** deviceInfo 抓取的属性列表；解析与抓取共用同一份定义。 */
export const DEVICE_INFO_PROPS = 'getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; wm size; wm density'

/**
 * 解析 deviceInfo 采用的 shell 输出。
 * 纯函数，便于用真机原始输出锁定「返回字段 == schema 声明字段」这个契约——
 * 曾经因为多返回了 refreshRate 而让 mobile_status 在真机上直接报
 * "not a declared property (additionalProperties: false)"。
 * @param {string} out shell 原始输出
 * @returns {{model:string, androidVersion:string, sdk:number, width:number, height:number, density:number, refreshRate:number}}
 */
export function parseDeviceInfo(out) {
  const lines = (out ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const pick = (re) => lines.find((l) => re.test(l)) ?? ''
  const size = /(\d+)x(\d+)/.exec(pick(/size/i))
  const density = /(\d+)/.exec(pick(/density/i))
  const refresh = /(\d+(?:\.\d+)?)/.exec(pick(/refresh/i))
  return {
    model: lines[0] ?? '',
    androidVersion: lines[1] ?? '',
    sdk: Number(lines[2] ?? 0),
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    density: density ? Number(density[1]) : 0,
    refreshRate: refresh ? Number(refresh[1]) : 0,
  }
}

/** 设备基础信息。 */
export async function deviceInfo(adb, serial, opts = {}) {
  return parseDeviceInfo(await shell(adb, serial, DEVICE_INFO_PROPS, opts))
}

/**
 * 抓取并解析当前界面的 UI 节点树。
 * 用 exec-out 拿原始字节，避免 Windows 上 adb shell 的 CRLF 破坏 XML。
 */
export async function dumpUi(adb, serial, opts = {}) {
  const remote = '/sdcard/dsh_ui_dump.xml'
  const out = await shell(adb, serial, `uiautomator dump ${remote} && cat ${remote} && rm -f ${remote}`, { timeout: 60_000, ...opts })
  const start = out.indexOf('<?xml')
  const rootStart = start >= 0 ? start : out.indexOf('<hierarchy')
  const end = out.lastIndexOf('</hierarchy>')
  if (rootStart < 0 || end < 0) throw new Error(`uiautomator dump 没有返回层次结构，原始输出前 200 字：${out.slice(0, 200)}`)
  return out.slice(rootStart, end + '</hierarchy>'.length)
}

/** 截图存盘，返回文件路径与尺寸。 */
export async function screenshot(adb, serial, filePath, opts = {}) {
  const png = await shellBinary(adb, serial, 'screencap -p', { timeout: 60_000, ...opts })
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50) {
    throw new Error(`screencap 没有返回 PNG（${png.length} 字节）`)
  }
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, png)
  return { path: filePath, bytes: png.length, ...pngSize(png) }
}

/** 从 PNG 的 IHDR 读宽高，省一个依赖。 */
export function pngSize(buf) {
  if (buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  return {}
}
