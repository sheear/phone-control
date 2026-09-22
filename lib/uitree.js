/**
 * 解析 uiautomator dump 的 <hierarchy> XML，扁平化成给模型的节点列表。
 * 手写解析器：只会遇到 <node .../> 与 <hierarchy>，属性值已由系统转义，
 * 不需要 namespace/DTD 支持，省掉一个依赖。
 */

/** 从 bounds 属性里抠出两个角点，并算中心。 */
export function parseBounds(s) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s ?? '')
  if (!m) return null
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2), w: x2 - x1, h: y2 - y1 }
}

/** 解掉 XML 实体。 */
export function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g

/** 把一段 `<node a="b" ...>` 的属性抽成对象。 */
function parseAttrs(s) {
  const attrs = {}
  ATTR_RE.lastIndex = 0
  let m
  while ((m = ATTR_RE.exec(s)) !== null) attrs[m[1]] = unescapeXml(m[2])
  return attrs
}

/**
 * 解析层次结构 XML，返回按文档顺序（父在前）的节点数组，附带属性。
 * @param {string} xml uiautomator dump 的 XML 文本
 * @returns {{nodes: Array<Record<string,string>>, attrCount: Record<string,number>}}
 */
export function parseHierarchy(xml) {
  const nodes = []
  const attrCount = {}
  const re = /<node\b([^>]*?)(\/?)>|<\/node>/g
  let m
  let pushed = 0
  while ((m = re.exec(xml)) !== null) {
    if (m[0] === '</node>') continue
    const attrs = parseAttrs(m[1])
    for (const k of Object.keys(attrs)) attrCount[k] = (attrCount[k] ?? 0) + 1
    const bounds = parseBounds(attrs.bounds)
    nodes.push({
      ...attrs,
      ...(bounds ?? {}),
      bounds: attrs.bounds ?? '',
      index: pushed++,
    })
  }
  return { nodes, attrCount }
}

const BOOL = new Set(['clickable', 'scrollable', 'checkable', 'checked', 'enabled', 'focusable', 'focused', 'selected', 'long-clickable', 'password'])

/** 这个节点"有信息量"吗——有文字/描述，或者可交互、可勾选、可滚动。 */
function isInteresting(n) {
  const hasText = Boolean(n.text || n['content-desc'])
  const interactive = n.clickable === 'true' || n['long-clickable'] === 'true' || n.scrollable === 'true' || n.checkable === 'true' || n.focusable === 'true'
  const hasRealBounds = (n.w ?? 0) > 0 && (n.h ?? 0) > 0
  return hasRealBounds && (hasText || interactive)
}

/**
 * 过滤 + 精简：默认丢掉没有任何文字与交互、或尺寸为 0 的容器节点。
 * @param {Array<Record<string,string>>} nodes parseHierarchy 的输出
 * @param {{all?: boolean, maxNodes?: number}} [opts] all=true 返回全部节点
 * @returns {{nodes: Array<object>, total: number, truncated: boolean}}
 */
export function simplify(nodes, opts = {}) {
  const { all = false, maxNodes = 400 } = opts
  const kept = all ? nodes : nodes.filter(isInteresting)
  const truncated = kept.length > maxNodes
  const slice = truncated ? kept.slice(0, maxNodes) : kept
  const out = slice.map((n) => {
    const o = {
      i: n.index,
      cls: (n.class ?? '').replace(/^android\.widget\./, '').replace(/^android\./, ''),
      b: [n.x1, n.y1, n.x2, n.y2],
      c: [n.cx, n.cy],
    }
    if (n.text) o.text = n.text
    if (n['content-desc']) o.desc = n['content-desc']
    if (n['resource-id']) o.id = n['resource-id']
    if (n.package) o.pkg = n.package
    for (const k of BOOL) {
      if (n[k] === 'true' && k !== 'enabled') o[k === 'long-clickable' ? 'longClickable' : k] = true
    }
    return o
  })
  return { nodes: out, total: nodes.length, shown: out.length, truncated }
}
