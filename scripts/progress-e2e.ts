/**
 * 多 worker 进度稳定性验收。
 *
 * 真实渲染一个 60 帧项目，3 个 worker：
 *  - progress.pct 只能递增
 *  - capture 阶段的 done 只能递增（worker 交错上报时不能被较小值覆盖）
 *  - 机器标记的 label 必须是中文阶段名，不能被人类进度条覆盖成 "Streaming frame..."
 *
 * 运行：npm run test:progress:e2e
 */

import assert from 'node:assert'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { RenderManager } from '../src/main/process/render-manager'
import { CliAdapter } from '../src/main/cli/cli-adapter'
import type { RenderRequest, RenderTaskState } from '../src/shared/types/render'

const ROOT = resolve(__dirname, '..', '..')
const WORK = join(ROOT, '.workbuddy', 'tmp', 'progress-e2e')
const PROJECT = join(WORK, 'project')
const OUT_DIR = join(WORK, 'out')
const REPORT_FILE = join(WORK, 'report.json')

interface Sample {
  pct: number | null
  done?: number
  total?: number
  code?: string
  label: string
}

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

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await sleep(250)
  }
  throw new Error(`等待渲染结束超时（${timeoutMs}ms）`)
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
    workers: 3,
    crf: null,
    videoBitrate: '',
    strict: false,
    gifLoop: 0,
    hlsSegmentSeconds: 4,
    projectPath: PROJECT,
    composition: '',
    outputDir: OUT_DIR,
    outputName: 'progress-test',
    projectMeta: { width: 640, height: 360, durationSec: 2, fps: 30 }
  }
}

async function prepareProject(templateBin: string): Promise<void> {
  await fs.rm(WORK, { recursive: true, force: true })
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
    .replace('>Title</h1>', '>HF Render Progress Test</h1>')
  await fs.mkdir(PROJECT, { recursive: true })
  await fs.writeFile(join(PROJECT, 'index.html'), html, 'utf-8')
}

async function main(): Promise<void> {
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

  const adapter = new CliAdapter(async () => cli.command)
  const caps = await adapter.probe()
  assert.ok(caps.render.ok, `CLI 不可用：${caps.render.error}`)

  const render = new RenderManager()
  render.setCliProvider(async () => caps)
  const samples: Sample[] = []
  render.onEvent((event) => {
    if (event.type !== 'task') return
    const p = event.task.progress
    if (p.pct == null && p.done == null) return
    samples.push({
      pct: p.pct,
      done: p.done,
      total: p.total,
      code: p.code,
      label: p.label
    })
  })

  console.log('\n[A] 真实渲染（60 帧 / 3 worker）')
  const started = await render.start(buildRequest(), cli.command, { autoScratch: false })
  assert.ok(started.ok, started.error ?? '渲染启动失败')
  await waitFor(
    () => ['succeeded', 'failed', 'canceled'].includes(render.getState().status),
    180_000
  )
  await sleep(1200)
  const task: RenderTaskState = render.getState()

  await check('渲染成功', async () => {
    assert.equal(task.status, 'succeeded', task.error ?? '渲染未成功')
    return { size: task.stats.sizeBytes }
  })

  await check('整体百分比只增不减', async () => {
    const list = samples.map((s) => s.pct).filter((v): v is number => v != null)
    assert.ok(list.length >= 3, `进度样本太少：${list.length}`)
    for (let i = 1; i < list.length; i += 1) {
      assert.ok(list[i] >= list[i - 1], `百分比回退：${list[i - 1]} → ${list[i]}`)
    }
    return { samples: list.length, from: list[0], to: list[list.length - 1] }
  })

  await check('capture 阶段已完成帧只增不减（worker 交错上报不回退）', async () => {
    const list = samples
      .filter((s) => s.code === 'capture' && s.done != null && s.total === 60)
      .map((s) => s.done as number)
    assert.ok(list.length >= 2, `capture 样本太少：${list.length}`)
    for (let i = 1; i < list.length; i += 1) {
      assert.ok(list[i] >= list[i - 1], `帧数回退：${list[i - 1]} → ${list[i]}  ${JSON.stringify(list)}`)
    }
    return { samples: list.length, max: list[list.length - 1] }
  })

  await check('机器标记的进度标签始终是中文阶段名', async () => {
    const labels = samples.filter((s) => s.code).map((s) => s.label)
    assert.ok(labels.length > 0, '没有机器标记样本')
    const bad = labels.filter((label) => /Streaming frame|Encoding frame|Assembling/i.test(label))
    assert.equal(bad.length, 0, `出现英文原始标签：${bad.join(' | ')}`)
    return { labels: [...new Set(labels)] }
  })

  await fs.writeFile(
    REPORT_FILE,
    JSON.stringify({ at: new Date().toISOString(), samples, results }, null, 2)
  )
  const passed = results.filter((r) => r.ok).length
  console.log(`\n结果：${passed}/${results.length} 通过 · 报告 ${REPORT_FILE}`)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
