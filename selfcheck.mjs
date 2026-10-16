/**
 * selfcheck.mjs —— 插件的"预检"：**两个半端都在本地真跑一遍**，不靠"重启一次才知道错哪"
 *
 * 为什么要有它（2026-10-14 连栽两次，都是重启后翻 `.dsh-web.err.log` 才发现）：
 *   ① `config` 的值是对象 ⇒ 定时器里 TypeError ⇒ **把整个 dsh 带走**；
 *   ② `parameters.patch` 是 `{ type:'object' }` ⇒ `defineTool` 抛 JsonSchemaError ⇒ **插件整条不激活**。
 *
 * 用法：`node --import ./tools/register.mjs selfcheck.mjs`（解析钩子见 tools/host-resolver.mjs）
 * 退出码：0 = 两个半端都正常；1 = 有问题（宿主里就会 "entry did not activate" / 设置页空白）
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX_HOME = join(tmpdir(), 'dsh-bili-duty-selfcheck')
const fail = (msg, e) => {
  console.error(`\n✗ ${msg}`)
  if (e) console.error(`  ${e?.name}: ${e?.message}`)
  const frame = String(e?.stack ?? '').split('\n').slice(1, 4).join('\n')
  if (frame) console.error(frame)
  process.exit(1)
}

/* ────────────── ① host 半端：假 ctx 上真跑 apply() ────────────── */

let mod
try {
  mod = await import('./index.js')
} catch (e) {
  fail('连 import index.js 都失败（依赖没解析？检查 tools/host-resolver.mjs）', e)
}

const registered = []
const fakeCtx = {
  // ⭐ 宿主给的是**函数**（`dshHomePath(...segments)`），这里照样给函数 —— 别用字符串
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(SANDBOX_HOME, ...seg) : undefined),
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (t) => { registered.push(t?.name ?? String(t)); return t } },
  webServer: { register: () => ({ dispose() {} }) },
  effect: (fn) => { try { return fn() } catch { return undefined } },
  settings: { register: () => ({}) },
  slots: { inject: () => {}, register: () => ({}) },
}

try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉就留着 */ }
mkdirSync(SANDBOX_HOME, { recursive: true })

try {
  mod.apply(fakeCtx, {})
} catch (e) {
  fail('host 半端 apply() 抛错了 —— 宿主里就是那句 `warning: 1 entry did not activate`', e)
}
console.log(`✓ host 半端 OK：name=${mod.name}  inject=${JSON.stringify(mod.inject)}  工具 ${registered.length} 个`)
for (const n of registered) console.log(`    - ${n}`)

/* ────────────── ② client 半端：假 window.__ModuleLoader__ 上真跑 factory() ────────────── */

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
let loaded = null
const prevWindow = globalThis.window
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
try {
  await import(`./client.js?selfcheck=${Date.now()}`)
} catch (e) {
  globalThis.window = prevWindow
  fail('client.js 一 import 就抛错（浏览器里会是一片空白）', e)
}
globalThis.window = prevWindow

if (!loaded) fail('client.js 没有调用 window.__ModuleLoader__.load({...}) —— 那它不会被挂上')
if (loaded.id !== pkg.name) fail(`client.js 的 id（${loaded.id}）必须等于 package.json 的 name（${pkg.name}）`)
if (typeof loaded.factory !== 'function') fail('client.js 的 load({...}) 里没有 factory 函数')

const fakeReact = {
  createElement: (...a) => ({ tag: a[0], props: a[1] }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  Fragment: 'Fragment',
}
let clientMod
try {
  clientMod = loaded.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`client.js require 了没预料到的包：${name}`)
  })
} catch (e) {
  fail('client.js 的 factory(require) 抛错', e)
}
if (typeof clientMod?.apply !== 'function') fail('client.js 的 factory 必须返回带 apply() 的对象')

// 真调一次 apply（假 DOM + 假 slots），把拼错的名字、漏掉的 ctx 方法都逼出来
const slotsReg = []
const styleNodes = []
const prevDoc = globalThis.document
globalThis.document = {
  createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
  head: { appendChild: (n) => styleNodes.push(n) },
}
try {
  clientMod.apply({
    effect: (fn) => { try { return fn() } catch { return undefined } },
    slots: {
      inject: (name, fn) => { fn() },
      register: (opts, Component) => { slotsReg.push({ ...opts, hasComponent: typeof Component === 'function' }); return {} },
    },
  })
} catch (e) {
  globalThis.document = prevDoc
  fail('client.js 的 apply(ctx) 抛错', e)
}
globalThis.document = prevDoc

if (!slotsReg.length) fail('client.js 的 apply 没有往任何 slot 注册组件')
if (!styleNodes.length) fail('client.js 的 apply 没有把样式挂上（页面会没样子）')
console.log(`✓ client 半端 OK：id=${loaded.id}  注入=${JSON.stringify(clientMod.inject)}`)
for (const s of slotsReg) console.log(`    slot ${s.name}  id=${s.id}  order=${s.order}  组件=${s.hasComponent ? '有' : '无 ✗'}`)

/* ────────────── ③ 把设置页**真渲染一遍**（假 React + 假 fetch） ──────────────
 * 为什么单加这一节（2026-10-17）：使用者报过"按钮灰的 / 点了没反应"——
 *   那种 bug 在"能 import、能 apply"的层面**一点看不出来**，只有把组件树真渲染一遍才炸得出来
 *   （比如渲染时引用一个不存在的助手函数 —— 这次就真缺过一个 `timeOf`，一渲染才发现的 ✗）。
 * 做法：一个几十行的假 React（useState / useEffect / createElement，带 hooks 槽位和重渲染循环）
 *   + 一个答 `/api/bili-duty/status` 的假 fetch（payload 照 status() 的真实形状编，
 *   故意把**新字段全开**：自定义时间段、perRound、plan 排班、accountName……全填上）。
 */
{
  // register 的第二个参数是 `() => h(Panel)` —— 重新 apply 一次把它挖出来
  //   （上面那次 apply 只记了"有没有组件"，没记组件本身）
  // ⚠️ 这一节全程都要有假 document：apply 里要 createElement('style')，渲染路径上也保不齐谁用它
  const prevDoc2 = globalThis.document
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
    head: { appendChild: () => {} },
  }

  // ── 假 React：hooks 槽位 + 脏标记重渲染 + 会递归的 createElement ──
  const slots = []
  const cleanups = []
  let cursor = 0, dirty = false
  const useState = (init) => {
    const i = cursor++
    if (!(i in slots)) slots[i] = { v: init }
    const s = slots[i]
    return [s.v, (nv) => { const n = typeof nv === 'function' ? nv(s.v) : nv; if (n !== s.v) { s.v = n; dirty = true } }]
  }
  const useEffect = (fn, deps) => {
    const i = cursor++
    const prev = slots[i]
    const changed = !prev || !Array.isArray(deps) || !Array.isArray(prev.deps)
      || deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k])
    if (changed) {
      if (prev && typeof prev.cleanup === 'function') cleanups.push(prev.cleanup)
      const c = fn()
      slots[i] = { deps, cleanup: typeof c === 'function' ? c : null }
    } else slots[i] = { deps: prev.deps, cleanup: prev.cleanup }
  }
  const createElement = (tag, props, ...children) => {
    if (typeof tag === 'function') return tag({ ...(props || {}), children })   // ← 递归，不递归等于没渲染
    return { tag, props: props || {}, children }
  }
  const fakeReact = { createElement, useState, useEffect, Fragment: 'Fragment' }

  // ⚠️ 必须**再用这个假 React 建一个 client 实例**：上面那个实例的 `h` 是"只记结构不递归"的
  //    createElement，拿它渲染等于没渲染（树里只剩一个空壳 ✗）—— 2026-10-17 实测踩到
  const clientMod2 = loaded.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`client.js require 了没预料到的包：${name}`)
  })
  let Comp = null
  const slots2 = { inject: (n, fn) => fn(), register: (opts, c) => { Comp = c; return {} } }
  clientMod2.apply({ effect: (fn) => { try { return fn() } catch { return undefined } }, slots: slots2 })
  if (typeof Comp !== 'function') { globalThis.document = prevDoc2; fail('没拿到设置页组件（render 检查无从谈起）') }

  // 假 fetch：只答 /status，其它一律 ok（这一节不点按钮，不会真发请求）
  const statusPayload = {
    ok: true, home: 'C:\\fake\\.dsh\\bili-duty',
    config: {
      perDay: 5, perRound: 2, peakValley: true, noon: true, night: true,
      customTime: true, t1Start: '12:00', t1End: '14:00', t2Start: '20:00', t2End: '01:00',
      autoComment: true, transcribe: false, asrModel: 'small',
      keywords: ['DeepSeek Harness'], commentPerRound: 5, mentionName: '批倒闭不变味',
      pythonPath: 'python', dshBin: '', headlessProfile: 'headless', overlayMcp: true,
      workspace: '', reportLevel: 'full', replyToComments: true, replyPerRound: 1, replyDepth: 5,
      replyOnlyMention: true, replyToMentions: true,
    },
    windows: {
      noon: { label: '时段一', start: '12:00', end: '14:00', on: true },
      night: { label: '时段二', start: '20:00', end: '01:00', on: true },
    },
    today: '2026-10-17', ranToday: 3, leftToday: 2, inWindowNow: 'night',
    plan: {
      window: 'night', label: '时段二', quota: 3, perRound: 2, done: 1, left: 1,
      nextAt: new Date(Date.now() + 3600_000).toISOString(),
      at: [new Date(Date.now() + 3600_000).toISOString()],
    },
    lastRunAt: new Date().toISOString(), lastWhy: 'window:night',
    loggedIn: true, venvReady: true, version: '9.9.9-selfcheck',
    installFailed: false, installing: false, asrReady: true, asrModelReady: true,
    asrInstalling: false, asrLog: '', asrTail: '', installLog: '', installTail: '',
    report: 'C:\\fake\\.dsh\\bili-duty\\out\\2026-10-17.md', log: 'C:\\fake\\.dsh\\bili-duty\\duty.log',
    accountName: 'last点潘神的大肥鱼', staleCode: false, codeFile: 'index.js',
  }
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/status') ? statusPayload : { ok: true }),
  })
  // 定时器桩：useStatus 会挂一个 5 秒轮询，不拦下来这个进程不肯退
  const prevSetInterval = globalThis.setInterval
  const liveIntervals = []
  globalThis.setInterval = (fn, ms) => { const id = prevSetInterval(() => {}, 1e9); liveIntervals.push(id); return id }

  let tree = null, renderPasses = 0
  const render = () => { cursor = 0; dirty = false; tree = createElement(Comp, {}) }
  try {
    // 第一遍：st 还是 null（/status 还没回来）⇒ 应该走"读设置中…"那条早退
    // 之后每遍都等一拍，让 /status 的 promise 落地、触发重渲染；没有待应用的更新才算稳
    for (let p = 0; p < 12; p++) {
      render()
      renderPasses++
      await new Promise((r) => prevSetInterval(r, 0))
      if (!dirty) break
    }
  } catch (e) {
    globalThis.fetch = prevFetch
    globalThis.setInterval = prevSetInterval
    globalThis.document = prevDoc2
    for (const id of liveIntervals) clearInterval(id)
    fail('设置页渲染抛错了（浏览器里就是一片空白 / 白屏）', e)
  }
  // 收尾：跑 effect 清理 + 还原全局桩
  for (const c of cleanups) { try { c() } catch { /* 清理出错不拦着检查 */ } }
  for (const id of liveIntervals) clearInterval(id)
  globalThis.fetch = prevFetch
  globalThis.setInterval = prevSetInterval
  globalThis.document = prevDoc2

  // 渲染出来了不算完 —— 得能看见"这一轮最多看几条"和排班进度（新功能的门面）
  const flat = JSON.stringify(tree)
  for (const needle of ['每轮最多看几条', '自定义时间段', '今天已看', '时段二', '这一窗排了']) {
    if (!flat.includes(needle)) fail(`设置页渲染出来了，但里面找不到「${needle}」（新设置项没上屏？）`)
  }
  console.log(`✓ client 半端渲染 OK：${renderPasses} 遍（含 /status 回来后的重渲染），树里有「每轮最多看几条 / 自定义时间段 / 排班进度」`)

  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 留着也无所谓 */ }
  console.log(`\n（预检不碰真家目录：host 用 ${SANDBOX_HOME}）`)
}
// ⚠️ 显式退出：这一版有异步渲染，桩定时器 / 宿主 spawn 的管道 / Windows 上没 flush 完的 stdout
//    会零星挂着（时序相关，不是插件缺陷）⇒ 不让它们决定进程什么时候退、也不让退出码漂移。
//    `fail()` 内部已经 `process.exit(1)`；走到这儿就是全绿。
process.exit(0)
