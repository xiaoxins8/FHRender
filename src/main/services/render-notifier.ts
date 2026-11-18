import { app, dialog, Notification, shell } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { RenderTaskState, VideoFormat } from '@shared/types/render'

export interface RenderNotificationPayload {
  taskId: string
  projectName: string
  outputPath: string
  /** 目录型输出（png-sequence / hls）直接打开目录 */
  directory: boolean
  bytes: number
}

interface NotificationTarget {
  taskId: string
  outputPath: string
  directory: boolean
  projectName: string
  createdAt: string
}

type NotificationRegistry = Record<string, NotificationTarget>

const PROTOCOL = 'hfrender'
const REGISTRY_FILE = 'render-notifications.json'
const MAX_TARGETS = 50

function isDirectoryFormat(format: VideoFormat | undefined): boolean {
  return format === 'png-sequence' || format === 'hls'
}

function projectNameOf(task: RenderTaskState): string {
  const projectPath = task.request?.projectPath?.trim()
  if (!projectPath) return ''
  return basename(resolve(projectPath))
}

/**
 * 判断一个任务是否真的「成功且产出可用」。
 *
 * 只认当前任务自带的真实信息：状态、输出路径、磁盘上的实际大小。
 * 失败 / 取消 / 没有产出 / 校验明确失败时都不发通知。
 */
export function describeRenderNotification(task: RenderTaskState): RenderNotificationPayload | null {
  if (task.status !== 'succeeded') return null
  const outputPath = task.stats.outputPath?.trim()
  if (!outputPath) return null
  const projectName = projectNameOf(task)
  if (!projectName) return null

  if (task.stats.sizeBytes == null || task.stats.sizeBytes <= 0) return null
  if (!existsSync(outputPath)) return null

  return {
    taskId: task.id,
    projectName,
    outputPath,
    directory: isDirectoryFormat(task.request?.format),
    bytes: task.stats.sizeBytes
  }
}

/** 打开输出位置：文件定位到文件，目录型输出直接打开目录；路径不存在时明确提示 */
export function revealOutput(outputPath: string, directory: boolean): void {
  if (!existsSync(outputPath)) {
    dialog.showErrorBox('无法打开输出位置', `路径不存在或已被移动：\n${outputPath}`)
    return
  }
  try {
    if (directory) {
      void shell.openPath(outputPath).then((error) => {
        if (error) dialog.showErrorBox('无法打开输出目录', error)
      })
    } else {
      shell.showItemInFolder(outputPath)
    }
  } catch (err) {
    dialog.showErrorBox('无法打开输出位置', err instanceof Error ? err.message : String(err))
  }
}

/* ------------------------------------------------------------------ */
/* 协议激活：绕开 Windows Toast 的 AUMID 激活器                            */
/* ------------------------------------------------------------------ */

/**
 * 注册 hfrender:// 协议。
 *
 * 为什么不用 Notification 的 actions 事件：
 * Windows 的 Toast 按钮走 AUMID 对应的 COM 激活器，开发模式（electron.exe）
 * 或激活器被旧进程注册过时，点击会启动一个没有 app 路径的 electron.exe。
 * 改成 protocol 激活后，由系统直接调起本应用并带上 hfrender://reveal?id=...，
 * 不再依赖那个激活器。
 */
export function registerNotificationProtocol(): void {
  if (process.platform !== 'win32') return
  try {
    if (process.defaultApp) {
      // 开发模式：electron.exe 需要显式带上当前应用路径
      const appPath = resolve(process.argv[1] ?? app.getAppPath())
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [appPath])
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL)
    }
  } catch {
    /* 注册失败时仍可发普通通知，只是按钮不可用 */
  }
}

/** 从进程参数里找出协议 URL（冷启动 / second-instance 都适用） */
export function extractProtocolUrl(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`)) ?? null
}

/** 只接受 hfrender://reveal?id=...，避免协议被拼进任意路径 */
export function parseRevealId(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${PROTOCOL}:` || parsed.hostname !== 'reveal') return null
    return parsed.searchParams.get('id')
  } catch {
    return null
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildToastXml(payload: RenderNotificationPayload): string {
  const url = `${PROTOCOL}://reveal?id=${encodeURIComponent(payload.taskId)}`
  return [
    `<toast activationType="protocol" launch="${escapeXml(url)}">`,
    '  <visual>',
    '    <binding template="ToastGeneric">',
    '      <text>渲染完成</text>',
    `      <text>《${escapeXml(payload.projectName)}》已完成渲染</text>`,
    '    </binding>',
    '  </visual>',
    '  <actions>',
    `    <action content="打开文件目录" activationType="protocol" arguments="${escapeXml(url)}"/>`,
    '  </actions>',
    '</toast>'
  ].join('\n')
}

export class RenderNotifier {
  /** 同一任务只通知一次（重试 / 重复任务事件都不重复弹） */
  private readonly sent = new Set<string>()
  private registry: NotificationRegistry | null = null

  private async loadRegistry(): Promise<NotificationRegistry> {
    if (this.registry) return this.registry
    try {
      const raw = await fs.readFile(join(app.getPath('userData'), REGISTRY_FILE), 'utf-8')
      const parsed = JSON.parse(raw) as NotificationRegistry
      this.registry = parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      this.registry = {}
    }
    return this.registry
  }

  private async saveRegistry(data: NotificationRegistry): Promise<void> {
    this.registry = data
    try {
      const file = join(app.getPath('userData'), REGISTRY_FILE)
      await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8')
    } catch {
      /* 写不进去时通知仍能显示，只是按钮点击后找不到目标 */
    }
  }

  private async remember(payload: RenderNotificationPayload): Promise<void> {
    const data = await this.loadRegistry()
    data[payload.taskId] = {
      taskId: payload.taskId,
      outputPath: payload.outputPath,
      directory: payload.directory,
      projectName: payload.projectName,
      createdAt: new Date().toISOString()
    }
    const entries = Object.values(data).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const next: NotificationRegistry = {}
    for (const entry of entries.slice(0, MAX_TARGETS)) next[entry.taskId] = entry
    await this.saveRegistry(next)
  }

  /** 协议回调：按通知 id 找回本次任务的真实输出路径并打开 */
  async handleProtocolUrl(url: string): Promise<boolean> {
    const id = parseRevealId(url)
    if (!id) return false
    const data = await this.loadRegistry()
    const target = data[id]
    if (!target) {
      dialog.showErrorBox('无法打开输出位置', '该通知对应的渲染记录已不存在，请在应用内打开输出目录。')
      return false
    }
    revealOutput(target.outputPath, target.directory)
    delete data[id]
    await this.saveRegistry(data)
    return true
  }

  async notify(task: RenderTaskState): Promise<boolean> {
    const payload = describeRenderNotification(task)
    if (!payload) return false
    if (this.sent.has(payload.taskId)) return false
    if (!Notification.isSupported()) return false

    // 先占位，避免并发任务事件重复弹通知
    this.sent.add(payload.taskId)
    if (this.sent.size > 200) {
      const oldest = this.sent.values().next().value
      if (oldest) this.sent.delete(oldest)
    }

    /*
     * Windows：protocol 激活。先把 taskId → 输出路径 写盘，
     * 这样即使应用已经退出，点击按钮后也能找回路径。
     */
    if (process.platform === 'win32') {
      await this.remember(payload)
      const notification = new Notification({
        toastXml: buildToastXml(payload),
        // toastXml 会覆盖 title/body，但保留一个可读标题便于系统记录
        title: '渲染完成',
        body: `《${payload.projectName}》已完成渲染`
      })
      notification.show()
      return true
    }

    // macOS / Linux：继续使用原生 actions + 点击事件
    const notification = new Notification({
      title: '渲染完成',
      body: `《${payload.projectName}》已完成渲染`,
      actions: [{ type: 'button', text: '打开文件目录' }]
    })
    const open = (): void => revealOutput(payload.outputPath, payload.directory)
    notification.on('action', () => open())
    notification.on('click', () => open())
    notification.show()
    return true
  }
}
