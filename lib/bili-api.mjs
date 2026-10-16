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
 * ⭐ 我们这个账号是谁（昵称 + mid）—— 只读一次 `/x/web-interface/nav`。
 *
 * 干什么用（2026-10-16 加）：使用者打开「**只回我 @ 的那个人**」之后，插件要能回答两个问题：
 *   ① 他填的那个昵称，是不是**就是插件登录的这个账号**？（如果是 ⇒ 根本没法对话，要当场说清楚，
 *      见 lib/threads.mjs 里那条自检 —— 不然会出现"我回我自己"这种谁都看不懂的现象 ✗）
 *   ② 除了昵称，我们还拿得到 **mid** ⇒ 之后按 UID 认人，昵称被别人冒用也不会答错人 ✓
 *
 * @returns {Promise<{mid:number, uname:string}|null>} 失败给 null（调用方照常往下走，别拦业务）
 */
export async function ownAccount(headers) {
  const d = await jget('https://api.bilibili.com/x/web-interface/nav', headers)
  if (d?.code !== 0 || !d?.data?.isLogin) return null
  return { mid: Number(d.data.mid) || 0, uname: String(d.data.uname || '') }
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

/** aid → BV 号（「收到的@」只给 aid，发评论要 BV） */
export async function bvidOfAid(aid, { headers, cache } = {}) {
  const key = `aid:${aid}`
  if (cache?.has(key)) return cache.get(key)
  const v = await jget(`https://api.bilibili.com/x/web-interface/view?aid=${Number(aid) || 0}`, headers)
  const bv = v?.code === 0 ? String(v.data?.bvid || '') : ''
  try { cache?.set(key, bv) } catch { /* 缓存不是必需品 */ }
  await sleep(250)
  return bv
}

/**
 * ⭐ 「收到的 @」（`GET /x/msgfeed/at`）——**只读**。
 *
 * 干什么用（2026-10-16 使用者："我希望在其他评论区@他他也能出来和我聊天"）：
 *   这是**唯一**能知道"有人在某个视频的评论区 @ 了我"的渠道 ——
 *   不然插件根本不知道该去哪个视频找（不可能全网扫评论 ✗）。
 *
 * ⚠️ 这个接口**官方没有公开的字段说明**（社区文档也只写到 `/x/msgfeed/reply`），
 *    所以下面的解析是**防御式**的：同一个信息试多个候选路径，取第一个有值的
 *    （例如"谁 @ 的"可能是 `user.nickname` 也可能是 `user.uname`）。
 *    解析不出来的项**不猜、直接跳过** —— 但原始载荷会原样带给调用方做诊断 ✓
 *
 * @returns {Promise<{ok:boolean, items:Array, error?:string, raw:number}>} `items` 是**原始**条目
 */
export async function fetchAtFeed(headers) {
  const d = await jget('https://api.bilibili.com/x/msgfeed/at?platform=web&build=0&mobi_app=web', headers)
  if (d?.code !== 0) return { ok: false, items: [], raw: 0, error: `接口回 code=${d?.code ?? '?'}${d?.message ? ' ' + d.message : ''}` }
  const items = Array.isArray(d?.data?.items) ? d.data.items : []
  return { ok: true, items, raw: items.length }
}

/** 从 uri 里抠出 BV 号 / 评论 rpid（`…/video/BVxxxx?…#reply1234567890`） */
export function parseAtUri(uri) {
  const s = String(uri || '')
  const bv = /(BV[0-9A-Za-z]{10})/.exec(s)?.[1] || ''
  const rpid = Number(/[#?&]reply(\d{5,})/.exec(s)?.[1]) || 0
  return { bvid: bv, rpid }
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
