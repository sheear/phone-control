/**
 * 命令构造纯函数。
 *
 * 抽出来的理由：`adb shell input ...` 这类命令的参数转义一旦写错，
 * 真机上的表现是「没反应」而不是报错，极难排查。做成纯函数就能在接手机之前
 * 用断言把命令文本钉死。
 */

/**
 * 转义 `adb shell input text` 的参数。
 *
 * 两层处理缺一不可：
 * 1. 在 PC 侧给 shell 元字符加反斜杠，避免被 dev 端 shell 拆词/解释；
 * 2. Android 的 Input.java 自己会处理 `%s`（空格）与反斜杠转义，
 *    所以空格也要加反斜杠（`%s` 在新版本上已不可靠）。
 *
 * @param {string} value 原始文本
 * @returns {string} 可安全放进双引号内的文本
 */
export function escapeForInputText(value) {
  return value.replace(/([\\"'`$&|;<>()*?[\]{}!#~ ])/g, '\\$1')
}

/**
 * 找出无法用 `input text` 传输的字符（非 ASCII 可见字符）。
 * @param {string} value
 * @returns {string[]} 去重后的非法字符
 */
export function findUntransportableChars(value) {
  const bad = [...value].filter((ch) => {
    const c = ch.codePointAt(0)
    return c < 0x20 || c > 0x7e
  })
  return [...new Set(bad)]
}

/** 构造点击命令。坐标取整，避免小数被 shell 当参数分隔。 */
export function buildTapCommand(x, y) {
  return `input tap ${Math.round(x)} ${Math.round(y)}`
}

/** 构造滑动命令。 */
export function buildSwipeCommand(x1, y1, x2, y2, durationMs = 300) {
  return `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(durationMs)}`
}

/** 构造按键命令。 */
export function buildKeyCommand(key) {
  return `input keyevent ${key}`
}

/** 构造文本输入命令。调用方需先用 findUntransportableChars 校验。 */
export function buildTextCommand(value) {
  return `input text "${escapeForInputText(value)}"`
}

/**
 * 把 mobile_ui 的节点列表压成紧凑 JSON 负载（与工具返回结构一致）。
 * @param {{total:number, shown:number, truncated:boolean, nodes:object[]}} result
 */
export function buildUiPayload(result) {
  return {
    total: result.total,
    shown: result.shown,
    ...(result.truncated ? { truncated: true } : {}),
    nodes: result.nodes,
  }
}
