/**
 * lib/state.mjs —— 插件的"家"与配置
 * ============================================================================
 * 规矩（抄 whale_craft）：**配置、凭证、报告、日志都放插件自己的家** ——
 * `$DSH_HOME/bili-duty/`，**绝不写进插件包目录**（装进 node_modules 后可能只读、升级也会被覆盖）。
 *
 * 还有一件小事但很要紧：vendored 的 `mcp_server.py` 里，凭证路径是
 * `Path(__file__).parent / "bili_credential.json"` —— 所以**运行时要把脚本拷到家目录里再跑**，
 * 这样凭证才会落在家的目录，而不是插件包里。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 谷时窗口（北京时间）—— 想改就改这一处。
 * ⭐ 官方口径（2026-09-10 起的新定价）：**高峰 = 工作日 9:00–12:00 与 14:00–18:00，其余全是谷时**
 *    ⇒ 12:00–14:00（夹在两个高峰之间）✓、18:00 之后的一整晚 ✓、以及**整个周末** ✓ 都便宜。
 * ⚠️ 我们原来写的 00:30–08:30 是 DeepSeek **早年**的错峰优惠时段，**已经过时** ✗
 *    —— 2026-10-14 使用者在"陌生人验收"里问「晚上峰谷真的是12点半才开始的吗」才查出来 ✓。
 */
export const WINDOWS = {
  noon: { label: '中午谷时', start: '12:00', end: '14:00' },
  night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
}

/**
 * ⭐ 2026-10-14 真机上踩到的坑（dsh 只留一句 `warning: 1 entry did not activate` + 堆栈）：
 *    `ctx.get('dshHomePath')` 返回的是**函数**，不是字符串！
 *    形状：`dshHomePath(...segments) => join(resolveDshHome(), ...segments)`（whale_craft 就是这么用的）。
 *    我一开始当字符串用（`String(p)`），路径就成了「函数源码 + \bili-duty」⇒ mkdir ENOENT ⇒ apply 抛错 ⇒ 插件不激活。
 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('bili-duty')                       // ← 函数形态：把目录名传进去
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'bili-duty')
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/** 首次运行：把 vendored 的 MCP 脚本和值班章程拷进家里（脚本变了就覆盖，章程不覆盖用户改过的） */
export function ensureHomeFiles(pluginDir, stateDir, log = () => {}) {
  const copies = [
    [join(pluginDir, 'vendor', 'bilibili-mcp', 'mcp_server.py'), join(stateDir, 'mcp_server.py'), true],
    [join(pluginDir, 'prompts', 'duty.md'), join(stateDir, 'duty.md'), false],
    [join(pluginDir, 'lib', 'asr.py'), join(stateDir, 'asr.py'), true],
  ]
  for (const [from, to, overwrite] of copies) {
    try {
      if (!existsSync(from)) { log(`缺文件：${from}`); continue }
      if (!overwrite && existsSync(to)) continue
      if (overwrite && existsSync(to) && readFileSync(from, 'utf8') === readFileSync(to, 'utf8')) continue
      copyFileSync(from, to)
      log(`已铺好：${to}`)
    } catch (e) { log(`铺 ${to} 失败：${e?.message ?? e}`) }
  }
}

/**
 * 时间串归一：只认 `H:MM` / `HH:MM`，且 **0≤时≤23、0≤分≤59**；不认就退回默认值。
 * 🔴 2026-10-17：原来两处各写一个 `/^\d{1,2}:\d{2}$/` —— 那个正则是**不校验范围**的，
 *    `25:99` 照样过 ⇒ minutesOf 算出 26:39 ⇒ 窗口变成"00:00–09:00"这种幽灵时段，
 *    排班还会排到明天去 ✗。现在**全库只此一份**（设置页存值、生效窗口、排班都走它），
 *    免得又漂开（这个仓库在"手抄两份"上摔过一次，见 index.js 的白名单）。
 */
export function normTime(v, fallback) {
  const s = String(v ?? '').trim()
  return /^([01]?\d|2[0-3]):([0-5]\d)$/.test(s) ? s : fallback
}

/** 'HH:MM' → 当天的分钟数（格式/范围不对 ⇒ null） */
function minutesOf(hhmm) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm).trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 现在在不在这个窗口里（支持跨零点，比如 23:00–02:00） */
export function inWindow(now, win) {
  const start = minutesOf(win.start); const end = minutesOf(win.end)
  if (start === null || end === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * ⭐ 现在落在哪个**窗口实例**里（不在任何窗口里 ⇒ null）。
 *
 * "实例" = 窗口的一次完整开启：跨零点的窗口属于**开始那天**（18:00 开的，到次日 9:00 都算它）。
 * 返回 `{ key, day, startAt, endAt }`（毫秒时间戳），给排班和状态页用。
 *
 * 🔴 2026-10-17 使用者当场踩到的 bug（`state.json` 里留着证据）—— 原来这里只是个
 *    `windowKey(now, name) = ${dayKey(now)}:${name}`：注释说"跨零点算前一天"，**代码根本没算** ✗
 *    于是 18:00–09:00 那个"晚上"窗口过了 0 点就变成全新的一轮
 *    （他的 state.json 里同时躺着 `2026-10-16:night` 和 `2026-10-17:night`，
 *      00:01 又跑了一整轮 —— 就是他那句"过了 0 点一股脑的浏览完"）。
 *    ⇒ `windowKey` 已删（留着迟早被人再用）：**实例归属一律看这里**，别自己拼 key。
 */
export function windowInstanceAt(now, win, name) {
  const s = minutesOf(win?.start); const e = minutesOf(win?.end)
  if (s === null || e === null) return null
  const cur = now.getHours() * 60 + now.getMinutes()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const DAY = 864e5
  const crossing = s > e
  const inside = crossing ? (cur >= s || cur < e) : (cur >= s && cur < e)
  if (!inside) return null
  // 跨零点的窗口：现在还没到 start 的那一段（00:00–end）属于**昨天**开的那一次
  const dayStart = crossing && cur < s ? midnight - DAY : midnight
  const startAt = dayStart + s * 60_000
  const endAt = (crossing ? dayStart + DAY : dayStart) + e * 60_000
  const d = new Date(dayStart)
  return { key: `${dayKey(d)}:${name}`, day: dayKey(d), startAt, endAt }
}

/**
 * 当前生效的窗口列表（给定时器 / 状态页 / 设置页共用）。
 *
 * ⭐ 2026-10-17 使用者的要求：「保留原本峰谷自动刷的设定，加个可以自定义时间的开关就行了」
 *    ⇒ `customTime` **关着**时用内置那两个谷时窗口（一字不改）；
 *       开着时用他自己填的两个时段（开始/结束都能改）。
 *    两个窗口的开关照旧是 `noon` / `night`（在自定义模式下就是"时段一/时段二"）。
 */
export function effectiveWindows(cfg) {
  const custom = Boolean(cfg?.customTime)
  return [
    {
      name: 'noon',
      label: custom ? '时段一' : '中午谷时',
      start: custom ? normTime(cfg.t1Start, WINDOWS.noon.start) : WINDOWS.noon.start,
      end: custom ? normTime(cfg.t1End, WINDOWS.noon.end) : WINDOWS.noon.end,
      on: Boolean(cfg?.noon),
    },
    {
      name: 'night',
      label: custom ? '时段二' : '晚上/夜间谷时',
      start: custom ? normTime(cfg.t2Start, WINDOWS.night.start) : WINDOWS.night.start,
      end: custom ? normTime(cfg.t2End, WINDOWS.night.end) : WINDOWS.night.end,
      on: Boolean(cfg?.night),
    },
  ]
}

/** 两个时刻之间最少隔多久再排下一轮（别把几轮挤在一起，那就又成"一股脑"了） */
export const MIN_GAP_MS = 5 * 60_000

/**
 * ⭐⭐ 把 N 轮**随机**排进 [fromAt, toAt] 这段时间里（2026-10-17 使用者要的"随机看"）。
 *
 * 做法：把这段时间切成 N 等份（每份留 8% 的边），**每一份里随机取一个点**。
 *   ⚠️ 为什么不是"整段里随机取 N 个点"：那样可能全挤在开头 —— 那就又变成他最烦的"一股脑"了。
 *      切成格子再随机 = **既随机、又摊得开** ✓（每格不会跨到别人那格去）
 * 时间不够（一段里塞不下 N 轮）时自动减少轮数（至少保 1 轮）：
 *   宁可少看几条，也别又挤成一堆 ✗（少看 = 省 token，多挤 = 惹人烦）
 *
 * @param {number} fromAt 从现在开始算（别排到过去去）
 * @param {number} toAt   窗口结束时刻
 * @param {number} n      想排几轮
 * @param {Function} rand 0~1 的随机源（可注入，方便测试）
 * @returns {number[]} 升序的时间戳
 */
export function planRuns(fromAt, toAt, n, rand = Math.random) {
  const span = Number(toAt) - Number(fromAt)
  if (!(span > 0) || !(n > 0)) return []
  const fit = Math.max(1, Math.min(Math.floor(span / MIN_GAP_MS) || 1, Math.floor(n)))
  const slot = span / fit
  const out = []
  for (let i = 0; i < fit; i++) {
    const lo = fromAt + i * slot + slot * 0.08
    const hi = fromAt + (i + 1) * slot - slot * 0.08
    out.push(Math.round(lo + Math.max(0, hi - lo) * rand()))
  }
  return out.sort((a, b) => a - b)
}
