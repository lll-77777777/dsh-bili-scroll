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
import { loadCredential, headersFor, ourMid, fetchThread, ownAccount, fetchAtFeed, parseAtUri, bvidOfAid, sleep } from './bili-api.mjs'

/**
 * 对话账本：
 *   `sent`     = 我们**真发出去过**的评论（收件箱唯一的来源）
 *   `threads`  = 每条串回过几次、回过哪一条
 *   `owner`    = ⭐ 使用者本人的 B站 身份（`{ mid, name }`）—— 靠昵称认一次，之后**按 UID 认死**
 *   `me`       = ⭐ **我们自己**的账号（`{ mid, uname }`）—— 给设置页显示"@ 哪个名字能叫我"
 * ⚠️ 读写都要**原样带上**这几个字段：`readLedger` 会重建对象，漏一个键就等于把这个字段擦掉 ✗
 */
export const conversationFileOf = (stateDir) => join(stateDir, 'conversation.json')

const emptyLedger = () => ({ sent: [], threads: {}, owner: {}, me: {} })

function readLedger(stateDir) {
  try {
    const j = JSON.parse(readFileSync(conversationFileOf(stateDir), 'utf8'))
    if (!j || typeof j !== 'object') return emptyLedger()
    const owner = (j.owner && typeof j.owner === 'object' && Number(j.owner.mid)) ? j.owner : {}
    const me = (j.me && typeof j.me === 'object' && String(j.me.uname || '').trim()) ? j.me : {}
    return {
      sent: Array.isArray(j.sent) ? j.sent.filter((x) => x && x.bv && Number(x.rpid)) : [],
      threads: (j.threads && typeof j.threads === 'object') ? j.threads : {},
      owner,
      me,
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
 * 多候选取值 —— 给「收到的@」那个**没有权威字段表**的接口用的。
 * 同一个信息在那边可能藏在好几个地方（`user.nickname` / `user.uname`…），
 * 所以按候选路径依次试，取第一个有值的；都没有就 `undefined`（**不猜** ✓）。
 */
function pick(obj, paths) {
  for (const p of paths) {
    let cur = obj
    for (const k of String(p).split('.')) {
      cur = cur?.[k]
      if (cur === undefined || cur === null) break
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur
  }
  return undefined
}

/** 「收到的@」里的一条 → 我们能用的形态（认不出来就给 null，绝不硬凑） */
export function normalizeAtItem(raw) {
  const it = raw?.item || {}
  const user = raw?.user || {}
  const uri = String(pick(it, ['uri', 'native_uri']) || '')
  const fromUri = parseAtUri(uri)
  const rpid = fromUri.rpid || Number(pick(it, ['source_id', 'target_id', 'reply.rpid', 'reply_id'])) || 0
  if (!rpid) return null
  return {
    bvid: fromUri.bvid || String(pick(it, ['bvid']) || ''),
    aid: Number(pick(it, ['business_id', 'subject_id', 'oid'])) || 0,
    rpid,
    root: Number(pick(it, ['root_id', 'reply.root'])) || 0,
    mid: Number(pick(user, ['mid', 'uid', 'id'])) || 0,
    uname: String(pick(user, ['nickname', 'uname', 'name']) || ''),
    text: String(pick(it, ['source_content', 'reply.content.message', 'reply.content', 'content.message', 'nat_text']) || ''),
    title: String(pick(it, ['title']) || ''),
    at: Number(pick(raw, ['at_time', 'item.at_time', 'time'])) || 0,
    uri,
  }
}


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
 * @param {{max?:number, depth?:number, maxAgeDays?:number, onlyName?:string, includeAt?:boolean, atMaxAgeDays?:number, log?:Function}} opts
 *   max         一次最多看几条串（每条串 = 2 次接口请求，别贪）
 *   depth       同一条串最多来回几轮（来自设置页 `replyDepth`）
 *   maxAgeDays  对方最后一句话超过这么多天的就算了（别把三个月前的串翻出来）
 *   onlyName    ⭐ 「只回我 @ 的那个人」：填使用者本人的 B站 昵称则**只认他一个人**，别人一律不理；
 *               留空 = 回所有人（旧行为）。见下面「认人的顺序」。
 *   includeAt   ⭐ 要不要顺带看「收到的 @」（别人在**任意视频评论区** @ 我们）—— 默认开
 *   atMaxAgeDays 「收到的 @」只认最近这么多天的（默认 7：不翻旧账）
 * @returns {Promise<{ok:boolean, items:Array, text:string, error?:string, scanned:number, why:Object, owner?:Object, me?:Object}>}
 */
export async function buildInbox(stateDir, {
  max = 8, depth = 5, maxAgeDays = 30, onlyName = '',
  includeAt = true, atMaxAgeDays = 7, log = () => {},
} = {}) {
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

  const headers = headersFor(cred)
  const cache = new Map()
  const mine = ourMid(cred)
  const now = Date.now()
  const items = []

  /**
   * ⭐⭐ 「只回我 @ 的那个人」/「只回复我就行了，不理其他人」（2026-10-16 使用者定的）。
   *
   * 🔴 自查：如果那个昵称**就是插件登录的这个账号**，这条功能根本没法工作
   *    （它分不清"自己说的"和"你说的"）⇒ 与其空转，不如当场说清楚。
   */
  const wantName = normName(onlyName)
  let ownerMid = Number(led.owner?.mid) || 0
  // 我们自己的账号（只读一次 nav）：① 给「要 @ 谁 == 插件自己」那条自查用；
  // ② 告诉使用者「在评论区 @ 这个名字就能把我叫出来」——
  //    这条提示很要紧：不认识自己的名字，使用者根本不知道该怎么 @ 它 ✓
  const me = await ownAccount(headers)
  // ⭐ 把自己是谁**记进账本**（1 次只读调用换后面无数次白读）：
  //    设置页要显示「在任意评论区 @ 这个名字就能把它叫出来」——
  //    不认识自己的名字，使用者根本不知道该怎么 @ 它 ✓
  if (me?.uname && (led.me?.uname !== me.uname || Number(led.me?.mid) !== me.mid)) {
    led.me = { mid: me.mid, uname: me.uname, at: new Date().toISOString() }
    writeLedger(stateDir, led)
  }
  if (wantName && me && normName(me.uname) === wantName) {
    return {
      ok: false, items: [], text: '', scanned: 0, why,
      error: `设置里「要 @ 谁」填的「${String(onlyName).replace(/^@+/, '')}」就是插件登录的这个账号 —— 它分不清"自己说的"和"你说的"，这样没法对话。`
        + ` 换个号：发评论用一个号、回话用另一个；或者把「要 @ 谁」改成你回话用的那个昵称。`,
    }
  }

  /**
   * ⭐ 认人：**先 UID，后昵称、昵称只认一次**（第一次按昵称认下就把 mid 钉进账本，
   *    之后别人改成同一个昵称也不算 ✓）。楼中楼和「收到的@」**共用这一个函数** ——
   *    两处各写一遍认人逻辑，迟早有一边漂掉 ✗
   * @returns {'ok'|'no'}
   */
  const isOwner = (mid, uname) => {
    if (!wantName) return 'ok'                                  // 没开白名单 ⇒ 谁都可以
    if (ownerMid) return Number(mid) === ownerMid ? 'ok' : 'no'  // 已经钉死了 UID
    if (normName(uname) !== wantName || !Number(mid)) return 'no'
    ownerMid = Number(mid)
    led.owner = { mid: ownerMid, name: String(uname || ''), at: new Date().toISOString() }
    writeLedger(stateDir, led)
    log(`对话：已认下使用者本人 = ${uname}（UID ${ownerMid}）—— 之后一律按 UID 认人，昵称被冒用也不会答错 ✓`)
    return 'ok'
  }

  /**
   * ⭐⭐ 「收到的 @」：使用者在**任意视频的评论区** @ 了我们
   *    （2026-10-16 他的原话：「我希望在其他评论区@他他也能出来和我聊天」）。
   *
   * 为什么必须靠它：这是**唯一**能知道"有人在某个我也不知道的视频里 @ 了我"的渠道 ——
   *   插件不可能全网扫评论 ✗。B站 会把 "@我" 记在账号的消息流里（`/x/msgfeed/at`），读它就行 ✓
   *
   * ⭐ 它只当**起头**用：我们一旦回了，那一串就进 `sent` 账本，之后走正常的楼中楼那条路 ✓
   *    （所以那些"回过了"的 @ 不会被反复拉出来，靠的还是同一本账）
   */
  const atKeys = new Set()
  if (includeAt) {
    const f = await fetchAtFeed(headers)
    if (!f.ok) { bump('「@我」接口没读到'); log(`「收到的@」读不到（${f.error}）`) }
    for (const raw of (f.items || [])) {
      const m = normalizeAtItem(raw)
      if (!m) { bump('@我那条解析不出评论号'); continue }
      if (isOwner(m.mid, m.uname) !== 'ok') { bump('@我的不是本人（不理）'); continue }
      if (m.at && atMaxAgeDays > 0 && now - m.at * 1000 > atMaxAgeDays * 864e5) {
        bump(`@我超过 ${atMaxAgeDays} 天（不翻旧账）`); continue
      }
      let bv = m.bvid
      if (!bv && m.aid) bv = await bvidOfAid(m.aid, { headers, cache })
      if (!bv) { bump('不是视频评论区（动态/专栏暂不支持）'); continue }

      const root = Number(m.root) || Number(m.rpid)     // 他发在顶层 ⇒ 就在他那条下面起一串
      const key = `${bv}:${root}`
      const book = led.threads?.[key] || {}
      if (book.lastTheirRpid && Number(book.lastTheirRpid) === Number(m.rpid)) { bump('这条 @ 已经回过了'); continue }

      // 他在已有楼里 @ 我们时，前面说过什么就在那一串里 ⇒ 顺手读一下（读不到也不影响回话）
      let history = []
      let ourCount = 0
      if (root !== Number(m.rpid)) {
        const t = await fetchThread(bv, root, { headers, cache })
        if (t.ok) {
          ourCount = mine ? t.replies.filter((x) => x.mid === mine).length : 0
          history = t.replies.slice(-6).map((x) => ({
            who: mine && x.mid === mine ? 'me' : 'them', uname: x.uname, text: clip(x.text, 200), at: iso(x.ctime),
          }))
        }
      }
      const turns = Math.max(ourCount, Number(book.turns) || 0)
      if (turns >= Number(depth || 0)) { bump('来回已经到顶'); continue }

      atKeys.add(key)
      items.push({
        via: 'at',
        bv,
        root,
        turns,
        left: Math.max(0, Number(depth) - turns),
        where: clip(m.title, 80),
        from: { rpid: m.rpid, uname: m.uname, uid: m.mid, text: clip(m.text, 300), at: iso(m.at) },
        history,
      })
      if (items.length >= Math.min(max, 5)) break     // @ 一次最多看 5 条，别一次性回一堆
    }
  }

  for (const th of threads) {
    if (atKeys.has(th.key)) { bump('已经在 @ 名单里了'); continue }
    const t = await fetchThread(th.bv, th.root, { headers, cache })
    if (!t.ok) { bump('接口没读到'); log(`对话：${th.bv} root=${th.root} 读不到（${t.error}）`); await sleep(400); continue }
    const msgs = t.replies
    if (!msgs.length) { bump('那一串是空的'); await sleep(400); continue }

    const last = msgs[msgs.length - 1]
    const lastIsMine = mine ? last.mid === mine : false
    if (lastIsMine) { bump('最后一句是我们说的'); await sleep(400); continue }

    // ⭐ 只回"那个人"：认不出来的一律跳过（使用者要的就是"不理其他人"）
    if (isOwner(last.mid, last.uname) !== 'ok') { bump('不是本人（不理）'); await sleep(400); continue }

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
      via: 'thread',
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

  const atCount = items.filter((x) => x.via === 'at').length
  log(`对话收件箱：看了 ${threads.length} 条串，${items.length} 条在等我回话（其中 ${atCount} 条是 @ 我）`
    + `${wantName ? `（只认本人${ownerMid ? ` UID ${ownerMid}` : '（还没认到，按昵称）'}）` : ''}`
    + (Object.keys(why).length ? '（其余：' + Object.entries(why).map(([k, v]) => `${k}×${v}`).join('、') + '）' : ''))
  return {
    ok: true, items, text: renderInbox(items), error: '', scanned: threads.length + atCount, why,
    // 给设置页 / 提示词用：「这次只认谁」以及**有没有认下来**
    onlyName: wantName ? String(onlyName).replace(/^@+/, '').trim() : '',
    owner: ownerMid ? { mid: ownerMid, name: led.owner?.name || '' } : {},
    // 我们自己的账号 —— 告诉使用者「在任意评论区 @ 这个名字就能把它叫出来」
    me: me ? { mid: me.mid, uname: me.uname } : null,
  }
}

/** 收件箱 → 给提示词看的纯文本（把 bili_reply 要填的 id 明确写出来，别让它自己猜） */
export function renderInbox(items) {
  if (!items?.length) return '（现在没有人在等你回话）'
  const lines = []
  items.forEach((it, i) => {
    const via = it.via === 'at'
      ? `（⭐ 这是他在**别的视频的评论区 @ 了你**${it.where ? `：《${it.where}》` : ''} —— 就在**他这条评论下面**回）`
      : ''
    lines.push(`### ${i + 1}) ${it.bv} · 这一串已经来回 ${it.turns} 轮，最多还能回 ${it.left} 轮${via}`)
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
