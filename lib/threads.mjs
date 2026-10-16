/**
 * lib/threads.mjs —— 评论区「来回对话」（谁在等我回话）
 * ============================================================================
 * 为什么要有它（2026-10-16 加的）：
 *   原来那条「回复评论」是**一次性**的 —— 章程写着"同一个人在同一话题下只回一次（别拉锯）"，
 *   于是评论区只能是"它 @ 你一次、你回一句、它再说一句"就到头了，成不了对话。
 *   现在把它做成**能来回**：你回它 → 它回你 → 你还能再回 → 它再回……直到
 *   ① 你不再说话、② 单条串到达**来回上限**（`replyDepth`）、或 ③ 它自己判断"收得住"。
 *
 * 🔴 这个模块**只读**，而且**只读一条路**：判重表（`seen.md`）里记着的、我们自己发过的评论，
 *    它们下面的楼中楼。**不去翻别人视频的评论区** —— 那会把它变成一个到处插话的机器人 ✗。
 *
 * 判据是"**这一串里最后说话的是谁**"（而不是"有没有新回复"）：
 *   · 最后一句是**对方**说的 ⇒ 我们欠他一句，进清单；
 *   · 最后一句是**我们**说的 ⇒ 到我们为止，闭嘴等着（这是"不刷屏"的机器级保证）。
 *
 * ⚠️ 两道防重复的闸：
 *   ① `turns`（来回轮数）来自两边取大：**接口数出来的**我方条数 与 **账本里记的**次数
 *      —— 账本记的是"我们**尝试发过**"的次数。接口看不到 ≠ 没发（审核中/被压）⇒ 只看接口
 *      会在下一轮又回一遍（重复打扰，正是 0.1.5 那条"接口成功 ≠ 公开可见"的同一类坑）；
 *   ② `lastTheirRpid`：同一条对方评论**只回一次**，哪怕它被压审、接口里看不见。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSeen } from './verify.mjs'
import { loadCredential, headersFor, ourMid, fetchThread, ownAccount, sleep } from './bili-api.mjs'

/**
 * 对话账本：
 *   `sent`     = 我们**真发出去过**的评论（收件箱唯一的来源）
 *   `threads`  = 每条串回过几次、回过哪一条
 *   `owner`    = ⭐ 使用者本人的 B站 身份（`{ mid, name }`）—— 靠昵称认一次，之后**按 UID 认死**
 */
export const conversationFileOf = (stateDir) => join(stateDir, 'conversation.json')

const emptyLedger = () => ({ sent: [], threads: {}, owner: {} })

function readLedger(stateDir) {
  try {
    const j = JSON.parse(readFileSync(conversationFileOf(stateDir), 'utf8'))
    if (!j || typeof j !== 'object') return emptyLedger()
    const owner = (j.owner && typeof j.owner === 'object' && Number(j.owner.mid)) ? j.owner : {}
    return {
      sent: Array.isArray(j.sent) ? j.sent.filter((x) => x && x.bv && Number(x.rpid)) : [],
      threads: (j.threads && typeof j.threads === 'object') ? j.threads : {},
      owner,
    }
  } catch { return emptyLedger() }
}

function writeLedger(stateDir, led) {
  try { writeFileSync(conversationFileOf(stateDir), JSON.stringify(led, null, 2), 'utf8') } catch { /* 写不了也不该让这一轮失败 */ }
}

/**
 * ⭐ 昵称归一化：B站 昵称可能带空白、可能有人写成 `@某某`，大小写也不该影响判断。
 *    只做"能想到的无害处理"，不做模糊匹配 —— 模糊匹配在"替人说话"这件事上太危险 ✗
 */
export const normName = (s) => String(s || '').replace(/^@+/, '').replace(/\s+/g, '').toLowerCase()

/**
 * ⭐ 归账（**发新评论 / 回楼中楼都调它**，成功才调）。
 *
 * 🔴 为什么宿主自己记一份（2026-10-16 实测发现的坑）：
 *    章程一直要求"把 BV + rpid + root 记进判重表"，但那是**靠模型自觉**——
 *    本机实跑的判重表里 99 行视频、**一条评论记录都没有**（模型就是没写）。
 *    而"谁在等我回话"整条链路都建立在"我们自己发过哪些评论"上 ⇒ 靠模型记 = 这条功能直接空转 ✗。
 *    ⇒ 改成**宿主在 `bili_reply` 成功那一刻自己记**（rpid 由内置 MCP 回执给出）。
 *      模型记的那份（判重表）照旧，只是不再当唯一来源。
 */
export function noteCommentSent(stateDir, { bv, rpid, root, text }) {
  const b = String(bv || '').trim()
  const r = Number(rpid) || 0
  if (!b || !r) return null
  const led = readLedger(stateDir)
  if (led.sent.some((x) => Number(x.rpid) === r)) return null   // 幂等：同一条只记一次
  led.sent.push({
    bv: b,
    rpid: r,
    root: Number(root) || 0,
    text: clip(String(text || ''), 80),
    at: new Date().toISOString(),
  })
  if (led.sent.length > 300) led.sent = led.sent.slice(-300)    // 别让它无限长
  writeLedger(stateDir, led)
  return led.sent[led.sent.length - 1]
}

/**
 * ⭐ 归账：宿主**回了一条楼中楼之后**调它（成功才调）。
 * @param {{bv:string, root:number, theirRpid:number}} p
 */
export function noteReplySent(stateDir, { bv, root, theirRpid }) {
  const key = `${String(bv || '').trim()}:${Number(root) || 0}`
  const led = readLedger(stateDir)
  const cur = led.threads[key] || { turns: 0 }
  led.threads[key] = {
    bv: String(bv || ''),
    root: Number(root) || 0,
    turns: (Number(cur.turns) || 0) + 1,                // 这次算一次（接口那边可能还没看见）
    lastTheirRpid: Number(theirRpid) || 0,
    at: new Date().toISOString(),
  }
  writeLedger(stateDir, led)
  return led.threads[key]
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
const iso = (sec) => (Number(sec) > 0 ? new Date(Number(sec) * 1000).toISOString() : '')

/**
 * ⭐ 归账：宿主**发出去一条回复之后**调它（成功才调）。
 * 由 `index.js` 里 `bili_reply` 那个工具包一层 —— 宿主自己知道 bvid / rpid / root，
 * 比让那一轮"记得去改账本"可靠得多（那一轮忘了写，下一轮就会重复回话 ✗）。
 *
 * @param {{bv:string, root:number, theirRpid:number}} p
 */
/**
 * 算一份「谁在等我回话」的清单。
 *
 * @param {string} stateDir 插件家目录
 * @param {{max?:number, depth?:number, maxAgeDays?:number, onlyName?:string, log?:Function}} opts
 *   max         一次最多看几条串（每条串 = 2 次接口请求，别贪）
 *   depth       同一条串最多来回几轮（来自设置页 `replyDepth`）
 *   maxAgeDays  对方最后一句话超过这么多天的就算了（别把三个月前的串翻出来）
 *   onlyName    ⭐ 「只回我 @ 的那个人」：填使用者本人的 B站 昵称则**只认他一个人**，别人一律不理；
 *               留空 = 回所有人（旧行为）。见下面「认人的顺序」。
 * @returns {Promise<{ok:boolean, items:Array, text:string, error?:string, scanned:number, why:Object, owner?:Object}>}
 */
export async function buildInbox(stateDir, { max = 8, depth = 5, maxAgeDays = 30, onlyName = '', log = () => {} } = {}) {
  const why = {}
  const bump = (k) => { why[k] = (why[k] || 0) + 1 }

  const cred = loadCredential(stateDir)
  if (!cred) return { ok: false, items: [], text: '', error: '还没扫码登录 —— 看评论区要用你自己的登录态', scanned: 0, why }

  const seenFile = join(stateDir, 'seen.md')
  const rows = existsSync(seenFile) ? parseSeen(readFileSync(seenFile, 'utf8')) : []
  const led = readLedger(stateDir)

  // ⭐ 两个来源（**宿主账本优先** —— 它比"模型记得去写"可靠；本机实测：判重表里 99 行视频、
  //    一条评论记录都没有，光靠模型记这条功能就是空转）：
  //      ① conversation.json 的 `sent`：我们自己发出去的每一条
  //      ② 判重表 `seen.md`：模型自己记的那份（留着，因为有人手改过判重表）
  //    一串只算一次；越新的越优先。
  const threads = []
  const seenKey = new Set()
  const push = (bv, root) => {
    const b = String(bv || '').trim()
    const r = Number(root) || 0
    if (!b || !r) return
    const key = `${b}:${r}`
    if (seenKey.has(key) || threads.length >= max) return
    seenKey.add(key)
    threads.push({ bv: b, root: r, key })
  }
  for (const s of led.sent.slice().reverse()) push(s.bv, Number(s.root) || Number(s.rpid))
  for (const r of rows.slice().reverse()) push(r.bv, Number(r.root) || Number(r.rpid))
  if (!threads.length) return { ok: true, items: [], text: '', scanned: 0, why, error: '' }

  const headers = headersFor(cred)
  const cache = new Map()
  const mine = ourMid(cred)
  const now = Date.now()
  const items = []

  /**
   * ⭐⭐ 「只回我 @ 的那个人」（2026-10-16 加：使用者要"只跟我说话，别人回我别理"）。
   *
   * 认人的顺序（**先 UID，后昵称；昵称只认一次**）：
   *   ① 账本里已经钉下 `owner.mid` ⇒ **只认这个 UID**，昵称一样也不算（防别人改名冒充 ✓）；
   *   ② 还没钉过 ⇒ 用昵称认**第一次**，认下来立刻把 mid 写进账本 ⇒ 之后按 UID 走。
   *
   * 🔴 自查：如果那个昵称**就是插件登录的这个账号**，这条功能根本没法工作
   *    （它分不清"自己说的"和"你说的"）⇒ 与其空转，不如当场说清楚。
   */
  const wantName = normName(onlyName)
  let ownerMid = Number(led.owner?.mid) || 0
  if (wantName) {
    const me = await ownAccount(headers)
    if (me && normName(me.uname) === wantName) {
      return {
        ok: false, items: [], text: '', scanned: 0, why,
        error: `设置里「要 @ 谁」填的「${String(onlyName).replace(/^@+/, '')}」就是插件登录的这个账号 —— 它分不清"自己说的"和"你说的"，这样没法对话。`
          + ` 换个号：发评论用一个号、回话用另一个；或者把「要 @ 谁」改成你回话用的那个昵称。`,
      }
    }
  }

  for (const th of threads) {
    const t = await fetchThread(th.bv, th.root, { headers, cache })
    if (!t.ok) { bump('接口没读到'); log(`对话：${th.bv} root=${th.root} 读不到（${t.error}）`); await sleep(400); continue }
    const msgs = t.replies
    if (!msgs.length) { bump('那一串是空的'); await sleep(400); continue }

    const last = msgs[msgs.length - 1]
    const lastIsMine = mine ? last.mid === mine : false
    if (lastIsMine) { bump('最后一句是我们说的'); await sleep(400); continue }

    // ⭐ 只回"那个人"：认不出来的一律跳过（使用者要的就是"不理其他人"）
    if (wantName) {
      if (ownerMid) {
        if (last.mid !== ownerMid) { bump('不是本人（不理）'); await sleep(400); continue }
      } else if (normName(last.uname) === wantName) {
        ownerMid = last.mid
        led.owner = { mid: last.mid, name: last.uname, at: new Date().toISOString() }
        writeLedger(stateDir, led)
        log(`对话：已认下使用者本人 = ${last.uname}（UID ${last.mid}）—— 之后一律按 UID 认人，昵称被冒用也不会答错 ✓`)
      } else {
        bump('不是本人（不理）'); await sleep(400); continue
      }
    }

    if (maxAgeDays > 0 && last.ctime > 0 && now - last.ctime * 1000 > maxAgeDays * 864e5) {
      bump(`最后一句超过 ${maxAgeDays} 天`); await sleep(400); continue
    }

    const book = led.threads?.[th.key] || {}
    if (book.lastTheirRpid && Number(book.lastTheirRpid) === Number(last.rpid)) {
      // 这一条对方评论我们已经回过了（哪怕它被压审、接口里看不见）⇒ 不重复回
      bump('这一条已经回过了'); await sleep(400); continue
    }

    const ourCount = mine ? msgs.filter((m) => m.mid === mine).length : 0
    const turns = Math.max(ourCount, Number(book.turns) || 0)
    if (turns >= Number(depth || 0)) { bump('来回已经到顶'); await sleep(400); continue }

    items.push({
      bv: th.bv,
      root: Number(th.root),
      turns,
      left: Math.max(0, Number(depth) - turns),
      from: { rpid: last.rpid, uname: last.uname, uid: last.mid, text: clip(last.text, 300), at: iso(last.ctime) },
      history: msgs.slice(-6).map((m) => ({
        who: mine && m.mid === mine ? 'me' : 'them',
        uname: m.uname,
        text: clip(m.text, 200),
        at: iso(m.ctime),
      })),
    })
    await sleep(600)
  }

  log(`对话收件箱：看了 ${threads.length} 条串，${items.length} 条在等我回话${wantName ? `（只认本人${ownerMid ? ` UID ${ownerMid}` : '（还没认到，按昵称）'}）` : ''}${Object.keys(why).length ? '（其余：' + Object.entries(why).map(([k, v]) => `${k}×${v}`).join('、') + '）' : ''}`)
  return {
    ok: true, items, text: renderInbox(items), error: '', scanned: threads.length, why,
    // 给设置页 / 提示词用：「这次只认谁」以及**有没有认下来**
    onlyName: wantName ? String(onlyName).replace(/^@+/, '').trim() : '',
    owner: ownerMid ? { mid: ownerMid, name: led.owner?.name || '' } : {},
  }
}

/** 收件箱 → 给提示词看的纯文本（把 bili_reply 要填的 id 明确写出来，别让它自己猜） */
export function renderInbox(items) {
  if (!items?.length) return '（现在没有人在等你回话）'
  const lines = []
  items.forEach((it, i) => {
    lines.push(`### ${i + 1}) ${it.bv} · 这一串已经来回 ${it.turns} 轮，最多还能回 ${it.left} 轮`)
    lines.push(`- 要有话说，就用 bili_reply 这么填：bvid="${it.bv}"  rpid=${it.from.rpid}  root=${it.root}`)
    lines.push(`- 说这话的人：${it.from.uname || '（没名字）'}（${it.from.at}）`)
    lines.push(`- 他说的：${it.from.text || '（空的）'}`)
    if (it.history?.length) {
      lines.push(`- 这段来回之前说过什么（按时间，最新的在最后）：`)
      for (const m of it.history) lines.push(`  - ${m.who === 'me' ? '我' : m.uname || '他'}：${m.text}`)
    }
    lines.push('')
  })
  return lines.join('\n')
}

// ── 单独跑（排查用）：node lib/threads.mjs <stateDir> ──
if (process.argv[1] && /threads\.mjs$/.test(process.argv[1])) {
  const dir = process.argv[2] || join(process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh'), 'bili-duty')
  const r = await buildInbox(dir, { log: (m) => console.log('  ' + m) })
  console.log(r.error ? '⚠️ ' + r.error : r.text)
  console.log('原始：' + JSON.stringify(r.why || {}))
}
