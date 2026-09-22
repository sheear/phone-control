/**
 * 路径解析：adb 可执行文件与截图目录。
 *
 * 关键约束：不能依赖 process.cwd()。宿主进程的工作目录由启动目录决定，
 * 从别处启动时依赖 cwd 去找 adb 就会落空。所以这里以「本包自身位置」为锚点，
 * 谁的进程加载了这个模块，就从谁的目录去找 platform-tools。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const isWin = process.platform === 'win32'

/** adb 可执行文件名（Windows 必须带 .exe）。 */
export const ADB_BIN = isWin ? 'adb.exe' : 'adb'

/** 本包根目录（lib/ 的上一级）。 */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 按优先级解析 adb 路径，返回第一个真实存在的候选；都不存在时返回裸名交给 PATH。
 *
 * 顺序：显式配置 → 环境变量 → 插件自带 → 包根/.tools → cwd/.tools → PATH。
 * @param {string|undefined} configured 插件配置里的 adbPath
 * @returns {string} adb 可执行路径或裸名
 */
export function resolveAdbPath(configured) {
  const candidates = []
  if (configured) candidates.push(configured)
  if (process.env.DSH_MOBILE_ADB) candidates.push(process.env.DSH_MOBILE_ADB)
  // 包内自带（最可靠：adb 跟着本包走，与启动目录无关）
  candidates.push(join(PACKAGE_ROOT, 'platform-tools', ADB_BIN))
  candidates.push(join(PACKAGE_ROOT, '.tools', 'platform-tools', ADB_BIN))
  // 仓库布局：本包被放在某个工作区目录下，platform-tools 落在工作区根
  candidates.push(join(PACKAGE_ROOT, '..', '.tools', 'platform-tools', ADB_BIN))
  candidates.push(join(process.cwd(), '.tools', 'platform-tools', ADB_BIN))
  candidates.push(join(process.cwd(), 'platform-tools', ADB_BIN))

  for (const c of candidates) {
    if (c === ADB_BIN) return c
    try {
      if (existsSync(c)) return c
    } catch {
      // 忽略不可访问的候选，继续下一个
    }
  }
  return ADB_BIN
}

/** 截图默认目录：工作区下的 _mobile_shots，不存在则创建由截图逻辑负责。 */
export function resolveScreenshotDir() {
  return join(process.cwd(), '_mobile_shots')
}
