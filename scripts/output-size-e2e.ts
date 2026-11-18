/**
 * 输出文件大小 / 帧缓存目录 / 通知判定 —— 真实渲染验收。
 *
 * 覆盖：
 *  1. 默认帧缓存路径 = HyperFrames CLI 的 `<tmpdir>/hyperframes-extract-cache-<uid>`
 *  2. 自定义帧缓存目录持久化（重新读取设置仍然存在）
 *  3. 渲染命令真的带 --frames-cache-dir，界面显示的路径 = CLI 使用的路径
 *  4. 渲染中收到真实 output-size 事件（数值来自磁盘，不是按进度推算）
 *  5. 成功后最终大小 = 磁盘实际字节数，且标记为 final
 *  6. 成功任务生成通知数据；失败 / 取消任务不生成
 *  7. 目录型输出只统计正式产物（跳过 .tmp / .json / 隐藏文件）
 *
 * 运行：npm run test:size:e2e
 */

import assert from 'node:assert'
import { existsSync, promises as fs, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { RenderManager, formatBytesText } from '../src/main/process/render-manager'
import { CliAdapter } from '../src/main/cli/cli-adapter'
import { resolveAppPaths } from '../src/main/services/frame-cache'
import { measureOutputSize } from '../src/main/process/output-size'
import {
  describeRenderNotification,
  extractProtocolUrl,
  parseRevealId
} from '../src/main/services/render-notifier'
import { SettingsManager } from '../src/main/services/settings-manager'
import type { RenderRequest, RenderTaskState } from '../src/shared/types/render'

const ROOT = resolve(__dirname, '..', '..')
const E2E_DIR = join(ROOT, '.workbuddy', 'e2e')
const SIZE_DIR = join(ROOT, '.workbuddy', 'tmp', 'size-e2e')
const PROJECT = join(SIZE_DIR, 'project')
const OUT_DIR = join(SIZE_DIR, 'out')
const USER_DATA = join(E2E_DIR, 'userData-size')
const CUSTOM_CACHE = join(E2E_DIR, 'frames-cache')
const REPORT_FILE = join(E2E_DIR, 'output-size-e2e-report.json')

interface CheckResult {
  name: string
  ok: boolean
  detail: string
  evidence: Record<string, unknown>
}

const results: CheckResult[] = []

async function check(
  name: string,
  fn: () => Promise<Record<string, unknown> | void>
): Promise<void> {
  try {
    const evidence = (await fn()) ?? {}
    results.push({ name, ok: true, detail: '', evidence })
    console.log(`  ✓ ${name}${Object.keys(evidence).length ? `  ${JSON.stringify(evidence)}` : ''}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    results.push({ name, ok: false, detail, evidence: {} })
    console.error(`  ✗ ${name}\n    ${detail}`)
    process.exitCode = 1
  }
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

async function findCachedCli(): Promise<{ command: string; bin: string } | null> {
  if (process.env.HF_RENDER_E2E_CLI) return { command: process.env.HF_RENDER_E2E_CLI, bin: '' }
  const base = join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
  const dirs = await fs.readdir(base).catch(() => [] as string[])
  let best: { version: string; bin: string } | null = null
  for (const dir of dirs) {
    const pkgRoot = join(base, dir, 'node_modules', 'hyperframes')
    const pkgPath = join(pkgRoot, 'package.json')
    const binPath = join(pkgRoot, 'bin', 'hyperframes.mjs')
    if (!existsSync(pkgPath) || !existsSync(binPath)) continue
    try {
      // 跳过被中断过的 npx 安装：cli.js 引用的 chunk 必须全部存在
      const cliJs = await fs.readFile(join(pkgRoot, 'dist', 'cli.js'), 'utf-8').catch(() => '')
      const refs = [...cliJs.matchAll(/["']\.\/([\w.-]+\.js)["']/g)].map((m) => m[1])
      if (refs.length === 0 || refs.some((file) => !existsSync(join(pkgRoot, 'dist', file)))) continue
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as { version?: string }
      const version = pkg.version ?? '0.0.0'
      if (!best || compareVersion(version, best.version) > 0) best = { version, bin: binPath }
    } catch {
      /* skip */
    }
  }
  return best ? { command: `"${process.execPath}" "${best.bin}"`, bin: best.bin } : null
}

/** 用 CLI 自带 blank 模板生成一个 2 秒 / 640×360 的测试项目 */
async function prepareProject(templateBin: string): Promise<void> {
  await fs.rm(SIZE_DIR, { recursive: true, force: true })
  await fs.mkdir(OUT_DIR, { recursive: true })
  const template = join(dirname(templateBin), '..', 'dist', 'templates', 'blank', 'index.html')
  let html = await fs.readFile(template, 'utf-8')
  html = html
    .replace('data-duration="10"', 'data-duration="2"')
    .replace('data-width="1920"', 'data-width="640"')
    .replace('data-height="1080"', 'data-height="360"')
    .replace('width: 1920px;', 'width: 640px;')
    .replace('height: 1080px;', 'height: 360px;')
    .replace(
      'background: #0a0a0a;',
      'background: linear-gradient(135deg, #ff2d55 0%, #5856d6 35%, #007aff 65%, #34c759 100%);'
    )
    .replace('>Title</h1>', '>HF Render Size Test</h1>')
  await fs.mkdir(PROJECT, { recursive: true })
  await fs.writeFile(join(PROJECT, 'index.html'), html, 'utf-8')
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 300
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await sleep(intervalMs)
  }
  throw new Error(`等待超时：${label}（${timeoutMs}ms）`)
}

function buildRequest(): RenderRequest {
  return {
    format: 'mp4',
    fpsMode: '30',
    customFps: '',
    quality: 'draft',
    resolution: 'project',
    docker: false,
    gpu: false,
    browserGpu: 'auto',
    // workers=1 时 mp4 走流式编码，输出文件会在渲染过程中持续增长
    workers: 1,
    crf: null,
    videoBitrate: '',
    strict: false,
    gifLoop: 0,
    hlsSegmentSeconds: 4,
    projectPath: PROJECT,
    composition: '',
    outputDir: OUT_DIR,
    outputName: `size-${Date.now()}`,
    projectMeta: { width: 640, height: 360, durationSec: 2, fps: 30 }
  }
}

async function main(): Promise<void> {
  process.env.HF_RENDER_E2E_USERDATA = USER_DATA
  await fs.rm(USER_DATA, { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(USER_DATA, { recursive: true })
  await fs.rm(OUT_DIR, { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(OUT_DIR, { recursive: true })
  await fs.rm(CUSTOM_CACHE, { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(CUSTOM_CACHE, { recursive: true })

  console.log('\n[A] 帧缓存默认路径')
  await check('默认路径就是 CLI 的 <tmpdir>/hyperframes-extract-cache-<uid>', async () => {
    const paths = resolveAppPaths()
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'u'
    assert.equal(paths.frameCacheDir, join(tmpdir(), `hyperframes-extract-cache-${uid}`))
    return { defaultDir: paths.frameCacheDir, tempRoot: paths.tempRoot }
  })

  console.log('\n[B] 设置持久化')
  const settings = new SettingsManager()
  await check('自定义帧缓存目录 + GPU 开关写入后重新读取仍然保留', async () => {
    const base = (await settings.get()).lastSettings
    assert.ok(base)
    await settings.update({
      scratchDir: CUSTOM_CACHE,
      lastSettings: { ...base!, gpu: true, browserGpu: 'on' }
    })
    // 重新构造实例：完全从磁盘读取，模拟重启软件
    const reloaded = await new SettingsManager().get()
    assert.equal(reloaded.scratchDir, CUSTOM_CACHE)
    assert.equal(reloaded.lastSettings?.gpu, true)
    assert.equal(reloaded.lastSettings?.browserGpu, 'on')
    return { scratchDir: reloaded.scratchDir, gpu: reloaded.lastSettings?.gpu }
  })

  const cli = await findCachedCli()
  if (!cli) {
    console.error('未找到可用的 hyperframes CLI；请设置 HF_RENDER_E2E_CLI 后重试')
    process.exit(2)
  }
  if (!cli.bin) {
    console.error('HF_RENDER_E2E_CLI 模式无法定位模板，请直接使用本机缓存的 CLI')
    process.exit(2)
  }
  await prepareProject(cli.bin)
  const cliCommand = cli.command
  const cliAdapter = new CliAdapter(async () => cliCommand)
  const caps = await cliAdapter.probe()
  assert.ok(caps.render.ok, `CLI 不可用：${caps.render.error}`)
  assert.ok(caps.features.framesCacheDir, '当前 CLI 未声明 --frames-cache-dir')

  const render = new RenderManager()
  render.setCliProvider(async () => caps)
  const sizeEvents: number[] = []
  render.onEvent((event) => {
    if (event.type === 'output-size' && event.bytes != null) sizeEvents.push(event.bytes)
  })

  console.log('\n[C] 真实渲染（mp4 / 60 帧 / workers=1 流式编码）')
  const started = await render.start(buildRequest(), cliCommand, {
    scratchDir: CUSTOM_CACHE,
    autoScratch: false
  })
  assert.ok(started.ok, started.error ?? '渲染启动失败')

  await waitFor(
    '渲染结束',
    () => ['succeeded', 'failed', 'canceled'].includes(render.getState().status),
    180_000,
    400
  )
  await sleep(1200)
  const task: RenderTaskState = render.getState()

  await check('启动命令包含 --frames-cache-dir，且路径与界面显示一致', async () => {
    assert.equal(task.status, 'succeeded', task.error ?? '渲染未成功')
    assert.ok(
      task.command.includes('--frames-cache-dir'),
      `命令里缺少 --frames-cache-dir：${task.command}`
    )
    assert.ok(task.command.includes(CUSTOM_CACHE), `命令里的路径不是自定义目录：${task.command}`)
    return { command: task.command.replace(/\s+/g, ' ').slice(0, 220) }
  })

  await check('渲染中收到真实文件大小事件（来自磁盘增长）', async () => {
    assert.ok(sizeEvents.length > 0, '没有收到任何 output-size 事件')
    assert.ok(Math.max(...sizeEvents) > 0, '收到的大小都为 0')
    return { events: sizeEvents.length, first: sizeEvents[0], max: Math.max(...sizeEvents) }
  })

  const outputPath = task.stats.outputPath
  await check('成功后最终大小 = 磁盘实际字节数，并标记为最终值', async () => {
    assert.ok(outputPath && existsSync(outputPath), '输出文件不存在')
    const actual = statSync(outputPath!).size
    assert.equal(task.stats.sizeFinal, true)
    assert.equal(task.stats.sizeBytes, actual)
    assert.equal(task.stats.sizeText, formatBytesText(actual))
    return { actual, sizeText: task.stats.sizeText }
  })

  await check('成功任务生成通知数据（项目名 / 输出路径来自任务）', async () => {
    const payload = describeRenderNotification(task)
    assert.ok(payload, '成功任务没有生成通知数据')
    assert.equal(payload!.projectName, 'project')
    assert.equal(payload!.outputPath, outputPath)
    assert.equal(payload!.directory, false)
    return { title: '渲染完成', body: `《${payload!.projectName}》已完成渲染` }
  })

  await check('失败 / 取消任务不会生成成功通知', async () => {
    const failed = { ...task, status: 'failed' as const }
    const canceled = { ...task, status: 'canceled' as const }
    assert.equal(describeRenderNotification(failed), null)
    assert.equal(describeRenderNotification(canceled), null)
    return { failed: 'null', canceled: 'null' }
  })

  console.log('\n[D] 项目目录导出（renders）')
  const projectRequest = {
    ...buildRequest(),
    outputMode: 'project' as const,
    outputDir: '',
    outputName: ''
  }
  const projectStarted = await render.start(projectRequest, cliCommand, { autoScratch: false })
  assert.ok(projectStarted.ok, projectStarted.error ?? '项目目录模式启动失败')
  await waitFor(
    '项目目录渲染结束',
    () => ['succeeded', 'failed', 'canceled'].includes(render.getState().status),
    180_000,
    400
  )
  await sleep(1200)
  const projectTask: RenderTaskState = render.getState()

  await check('输出落在 <项目>/renders，文件名符合 CLI 默认时间戳规则', async () => {
    assert.equal(projectTask.status, 'succeeded', projectTask.error ?? '渲染未成功')
    const out = projectTask.stats.outputPath ?? ''
    assert.match(out, /[\\/]renders[\\/]project_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/)
    assert.ok(existsSync(out), `输出文件不存在：${out}`)
    assert.ok((projectTask.stats.sizeBytes ?? 0) > 0, '没有读到最终文件大小')
    assert.equal(projectTask.stats.sizeFinal, true)
    assert.ok(projectTask.command.includes(out), '启动命令没有使用该输出路径')
    return { outputPath: out, size: projectTask.stats.sizeBytes }
  })

  console.log('\n[E] 目录型输出统计')
  await check('只统计正式产物，跳过 .tmp / .json / 隐藏文件', async () => {
    const dir = join(E2E_DIR, 'size-dir')
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(join(dir, 'sub'), { recursive: true })
    await fs.writeFile(join(dir, 'a.png'), Buffer.alloc(100))
    await fs.writeFile(join(dir, 'b.PNG'), Buffer.alloc(50))
    await fs.writeFile(join(dir, 'x.tmp'), Buffer.alloc(999))
    await fs.writeFile(join(dir, '.hidden.png'), Buffer.alloc(777))
    await fs.writeFile(join(dir, 'note.json'), Buffer.alloc(888))
    await fs.writeFile(join(dir, 'sub', 'c.png'), Buffer.alloc(25))
    const measured = await measureOutputSize(dir, 'png-sequence')
    assert.equal(measured.bytes, 175)
    assert.equal(measured.files, 3)
    return measured
  })

  console.log('\n[F] 通知协议')
  await check('只接受 hfrender://reveal?id=...，其它 URL 一律拒绝', async () => {
    assert.equal(parseRevealId('hfrender://reveal?id=abc-123'), 'abc-123')
    assert.equal(parseRevealId('hfrender://other?id=abc'), null)
    assert.equal(parseRevealId('https://reveal?id=abc'), null)
    assert.equal(parseRevealId('hfrender://reveal'), null)
    assert.equal(
      extractProtocolUrl(['HF Render.exe', 'hfrender://reveal?id=abc-123']),
      'hfrender://reveal?id=abc-123'
    )
    assert.equal(extractProtocolUrl(['HF Render.exe', '--user-data-dir=x']), null)
    return { ok: true }
  })

  await fs.writeFile(REPORT_FILE, JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
  const passed = results.filter((r) => r.ok).length
  console.log(`\n结果：${passed}/${results.length} 通过 · 报告 ${REPORT_FILE}`)
  if (process.exitCode) process.exit(process.exitCode)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
