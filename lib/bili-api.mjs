/**
 * lib/bili-api.mjs —— B站 **只读** 接口的公共底子
 * ============================================================================
 * 为什么要抽这一层（2026-10-16）：
 *   「评论发出后复核」（`lib/verify.mjs`）和「评论区来回对话」（`lib/threads.mjs`）
 *   读的是**同一批接口、同一份凭证、同一套请求头、同一个错峰 sleep**。
 *   各写一遍的下场是：哪天凭证字段或 UA 改了，只改一边 ⇒ 另一边悄悄失效（最难查的那类 bug）。
 *   ⇒ **传输层的知识只留一份**：凭证 / 请求头 / GET / BV→aid / 读一串楼中楼。
 *
 * 🔴 这一层**只读**，一个写操作都不许进来。
 *    发评论走的是插件内部那个 Python MCP（`vendor/bilibili-mcp/mcp_server.py`）——
 *    那条路才带着 bilibili-api 对 @ 与风控的常识（csrf、root/parent 的成对规则）。
 *    这里自己拼一个 POST 出去，迟早会在某个边界上翻车。
 *
 * ⚠️ 出错的规矩是「**别抛**」：一律返回 `{ code, ... }` 或 `{ ok: false, error }`，
 *    让调用方自己决定「是跳过还是记账」—— 复核 / 对话都不该因为一条接口抖动就整轮失败。
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从插件家目录读凭证（没有 / 不完整就 null —— 调用方据此回一句"先去扫码登录"） */
export function loadCredential(stateDir) {
  const f = join(stateDir, 'bili_credential.json')
  if (!existsSync(f)) return null
  try {
    const c = JSON.parse(readFileSync(f, 'utf8'))
    if (!c?.sessdata) return null
    return c
  } catch { return null }
}

export function headersFor(cred) {
  return {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
  }
}

/** 拿 JSON；网络/解析失败也不抛，给一个 `code: -998/-999` 的壳 */
export async function jget(url, headers) {
  try {
    const r = await fetch(url, { headers })
    const t = await r.text()
    try { return JSON.parse(t) } catch { return { code: -999, message: 'not json' } }
  } catch (e) { return { code: -998, message: String(e?.message ?? e) } }
}

/** 我们自己的 mid（从凭证里读；读不到返回 0，调用方要能接受"认不出自己") */
export function ourMid(cred) {
  const v = String(cred?.dedeuserid || cred?.DedeUserID || '')
  return /^\d+$/.test(v) ? Number(v) : 0
}

/**
 * BV → 视频元信息（带缓存 + 小睡：同一个视频别在一条链路里问两遍）
 * @returns {Promise<{aid:number, mid:number, title:string}|null>}
 */
export async function videoMeta(bvid, { headers, cache } = {}) {
  if (cache?.has(bvid)) return cache.get(bvid)
  const v = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, headers)
  const meta = v?.code === 0
    ? { aid: v.data.aid, mid: v.data.owner?.mid, title: v.data.title }
    : null
  try { cache?.set(bvid, meta) } catch { /* 缓存不是必需品 */ }
  await sleep(300)
  return meta
}

/**
 * 读**一串楼中楼**（`root` 底下所有子评论，按时间正序）。
 *
 * ⚠️ 实测口径（2026-10-16，`lib/verify.mjs` 里已经踩过一遍）：
 *   · 只有这条路能按 root 精确拉一串：`/x/v2/reply/reply?type=1&oid=<aid>&root=<root>`
 *   · ✗ `/x/v2/reply/detail` 走不通（回 `-400 请求错误`）—— 别无谓地换它
 *   · 这一串**不一定包含 root 自己那条**（根评论是"视频下的评论"，不是"楼中楼"），
 *     所以调用方别假设第一条就是根。
 *
 * @returns {Promise<{ok:boolean, replies:Array, error?:string, total?:number}>}
 */
export async function fetchThread(bvid, root, { headers, cache, ps = 20, pn = 1 } = {}) {
  const meta = await videoMeta(bvid, { headers, cache })
  if (!meta) return { ok: false, replies: [], error: '取视频信息失败（视频可能已删/不可见）' }
  const d = await jget(
    `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${meta.aid}&root=${root}&ps=${ps}&pn=${pn}`,
    headers,
  )
  if (d?.code !== 0) {
    return { ok: false, replies: [], error: `接口回 code=${d?.code ?? '?'}${d?.message ? ' ' + d.message : ''}` }
  }
  const list = (d?.data?.replies || []).map((r) => ({
    rpid: Number(r.rpid) || 0,
    root: Number(r.root) || 0,
    parent: Number(r.parent) || 0,
    mid: Number(r.mid) || Number(r.member?.mid) || 0,
    uname: String(r.member?.uname || ''),
    text: String(r.content?.message || ''),
    ctime: Number(r.ctime) || 0,
    like: Number(r.like) || 0,
    invisible: Boolean(r.invisible),
  })).sort((a, b) => a.ctime - b.ctime)
  return { ok: true, replies: list, total: Number(d?.data?.page?.count) || list.length }
}
