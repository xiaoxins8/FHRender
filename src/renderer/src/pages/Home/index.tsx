import { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectSelector } from '../../components/ProjectSelector'
import { PresetSelector } from '../../components/PresetSelector'
import { ExportSettings } from '../../components/ExportSettings'
import { AdvancedSettings } from '../../components/AdvancedSettings'
import { RenderProgress } from '../../components/RenderProgress'
import { ConsolePanel } from '../../components/ConsolePanel'
import { EnvDialog } from '../../components/EnvDialog'
import { TitleBar } from '../../components/TitleBar'
import { PreviewButton } from '../../components/preview/PreviewButton'
import { PreviewStatus } from '../../components/preview/PreviewStatus'
import { Button, ConfirmDialog, Icon, Spinner } from '../../components/ui'
import { usePreview } from '../../services/use-preview'
import {
  api,
  buildRequest,
  defaultRenderSettings,
  EXTENSION_MAP,
  isDirectoryFormat,
  joinPath
} from '../../services/api'
import { DEFAULT_SETTINGS } from '../../services/constants'
import type { ProjectInfo, RecentProject } from '@shared/types/project'
import type {
  ExportMode,
  RenderHistoryEntry,
  RenderLogLine,
  RenderSettings,
  RenderTaskState
} from '@shared/types/render'
import type { AppPaths, AppSettings, EnvironmentReport, RenderPreset } from '@shared/types/settings'
import type { LintResult } from '@shared/ipc'
import type { PageId } from '../types'

interface Toast {
  id: number
  message: string
  tone: 'ok' | 'error'
}

const IDLE_TASK: RenderTaskState = {
  id: 'idle',
  status: 'idle',
  request: null,
  command: '',
  progress: { pct: null, label: '等待开始' },
  stats: {}
}

/**
 * 首次启动读到的设置快照。
 * 应用内切页（渲染 ↔ 性能）会让 Home 重新挂载，若每次都要等设置 IPC 才渲染，
 * 界面会闪一遍启动加载页、按钮也短暂点不到 —— 用这份缓存直接首屏渲染。
 */
interface BootSnapshot {
  appSettings: AppSettings
  presets: RenderPreset[]
  task: RenderTaskState
  /** 上次成功打开的项目，重挂载时先顶上，避免按钮短暂不可用 */
  project: ProjectInfo | null
  /** 主进程解析的默认路径（切页时直接复用，不重复探测） */
  paths?: AppPaths
}
let bootSnapshot: BootSnapshot | null = null

interface HomeProps {
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  page: PageId
  onNavigate: (page: PageId) => void
}

export function Home(props: HomeProps): JSX.Element {
  const [ready, setReady] = useState(bootSnapshot !== null)
  const [settings, setSettings] = useState<RenderSettings>(
    () => bootSnapshot?.appSettings.lastSettings ?? defaultRenderSettings()
  )
  const [project, setProject] = useState<ProjectInfo | null>(() => bootSnapshot?.project ?? null)
  const [projectError, setProjectError] = useState<string | undefined>()
  const [scanning, setScanning] = useState(false)
  const [recent, setRecent] = useState<RecentProject[]>(() => bootSnapshot?.appSettings.recentProjects ?? [])
  const [htmlFiles, setHtmlFiles] = useState<string[]>([])
  const [composition, setComposition] = useState(() => bootSnapshot?.appSettings.lastComposition ?? '')
  const [exportMode, setExportMode] = useState<ExportMode>(
    () => bootSnapshot?.appSettings.exportMode ?? 'custom'
  )
  const [outputDir, setOutputDir] = useState(() => bootSnapshot?.appSettings.lastOutputDir ?? '')
  const [outputName, setOutputName] = useState('')
  const [recentOutputDirs, setRecentOutputDirs] = useState<string[]>(
    () => bootSnapshot?.appSettings.recentOutputDirs ?? []
  )
  const [presets, setPresets] = useState<RenderPreset[]>(() => bootSnapshot?.presets ?? [])
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  const [presetBaseline, setPresetBaseline] = useState<RenderSettings | null>(null)
  const [task, setTask] = useState<RenderTaskState>(() => bootSnapshot?.task ?? IDLE_TASK)
  const [taskHistory, setTaskHistory] = useState<RenderHistoryEntry[]>([])
  const [logs, setLogs] = useState<RenderLogLine[]>([])
  const [cliCommand, setCliCommand] = useState(
    () => bootSnapshot?.appSettings.cliCommand || DEFAULT_SETTINGS.cliCommand
  )
  const [autoEnvCheck, setAutoEnvCheck] = useState(() => bootSnapshot?.appSettings.autoEnvCheck ?? true)
  const [scratchDir, setScratchDir] = useState(() => bootSnapshot?.appSettings.scratchDir ?? '')
  /** HyperFrames 实际生效的默认帧缓存路径（空设置时显示它） */
  const [frameCacheDefault, setFrameCacheDefault] = useState(
    () => bootSnapshot?.paths?.frameCacheDir ?? ''
  )
  const [autoScratch, setAutoScratch] = useState(
    () => bootSnapshot?.appSettings.autoScratch !== false
  )
  /** 停止渲染的二次确认弹窗 */
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false)
  const [env, setEnv] = useState<EnvironmentReport | null>(null)
  const [envOpen, setEnvOpen] = useState(false)
  const [envLoading, setEnvLoading] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [starting, setStarting] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const appSettingsRef = useRef<AppSettings | null>(null)

  const busy = task.status === 'running' || task.status === 'preparing'
  const dirty = presetBaseline ? JSON.stringify(presetBaseline) !== JSON.stringify(settings) : false

  const preview = usePreview(project?.path ?? null)

  const showToast = useCallback((message: string, tone: 'ok' | 'error' = 'ok') => {
    setToast({ id: Date.now(), message, tone })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2800)
  }, [])

  /* ---------------------------- 初始化 ---------------------------- */

  useEffect(() => {
    let cancelled = false

    const boot = async (): Promise<void> => {
      try {
        const [appSettings, presetList, state, paths] = await Promise.all([
          api().settings.get(),
          api().presets.list(),
          api().render.state(),
          // 主进程已缓存解析结果，这里只是读取，不会重复执行环境检测
          api().app.paths()
        ])
        if (cancelled) return

        appSettingsRef.current = appSettings
        settingsLoadedRef.current = true
        bootSnapshot = {
          appSettings,
          presets: presetList,
          task: state,
          project: bootSnapshot?.project ?? null,
          paths
        }
        setFrameCacheDefault(paths.frameCacheDir)
        setCliCommand(appSettings.cliCommand || DEFAULT_SETTINGS.cliCommand)
        setAutoEnvCheck(appSettings.autoEnvCheck)
        setScratchDir(appSettings.scratchDir ?? '')
        setAutoScratch(appSettings.autoScratch !== false)
        setRecent(appSettings.recentProjects)
        setRecentOutputDirs(appSettings.recentOutputDirs)
        setPresets(presetList)
        if (appSettings.lastSettings) {
          setSettings(appSettings.lastSettings)
          lastSavedSettingsRef.current = JSON.stringify(appSettings.lastSettings)
        }
        setExportMode(appSettings.exportMode)
        if (appSettings.lastOutputDir) setOutputDir(appSettings.lastOutputDir)
        if (appSettings.lastComposition) setComposition(appSettings.lastComposition)
        setTask(state)

        const last = appSettings.recentProjects[0]
        if (last) {
          await openProject(last.path, {
            silent: true,
            composition: appSettings.lastComposition ?? null
          })
        }
        if (cancelled) return
        setReady(true)

        if (appSettings.autoEnvCheck) void runEnvCheck(last?.path)
      } catch (err) {
        // 启动链路任何一步失败都不能把界面永久卡在加载页：降级用默认值直接进入主界面
        console.error('[boot] 读取本地设置失败，使用默认值进入主界面', err)
        if (cancelled) return
        setReady(true)
      }
    }

    void boot()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ------------------------ 参数变化即持久化 ------------------------ */
  /**
   * 导出参数一有变化就落盘：应用内切页（渲染 ↔ 性能）会让 Home 重新挂载，
   * 重挂载后的初始值来自 lastSettings。以前只有「开始渲染成功」才写盘，
   * 导致只改了视频质量就切页再切回来时，参数被磁盘上的旧值顶掉（如回到 draft）。
   * 防抖 400ms 避免连续调整时频繁写盘；与已落盘值相同则跳过。
   */
  const lastSavedSettingsRef = useRef<string | null>(
    bootSnapshot ? JSON.stringify(bootSnapshot.appSettings.lastSettings) : null
  )
  const latestSettingsRef = useRef(settings)
  /** 设置是否已从磁盘读完：读完之前绝不能用界面默认值覆盖存档 */
  const settingsLoadedRef = useRef(bootSnapshot !== null)

  const persistSettings = useCallback((value: RenderSettings): void => {
    // 落盘的同时更新 latest 引用：关窗 / 切页时的 flush 不会拿旧值覆盖新值
    latestSettingsRef.current = value
    lastSavedSettingsRef.current = JSON.stringify(value)
    void api()
      .settings.update({ lastSettings: value })
      .then((next) => {
        appSettingsRef.current = next
        // 同步首屏快照，切页重挂载时立即拿到最新参数
        if (bootSnapshot) bootSnapshot.appSettings.lastSettings = value
      })
      .catch(() => undefined)
  }, [])

  const flushSettings = useCallback((): void => {
    if (!settingsLoadedRef.current) return
    const value = latestSettingsRef.current
    if (JSON.stringify(value) === lastSavedSettingsRef.current) return
    persistSettings(value)
  }, [persistSettings])

  useEffect(() => {
    latestSettingsRef.current = settings
    if (!ready) return
    if (JSON.stringify(settings) === lastSavedSettingsRef.current) return
    const timer = setTimeout(flushSettings, 400)
    return () => clearTimeout(timer)
  }, [settings, ready, flushSettings])

  /*
   * 切页 / 关窗时把待写入的改动立即落盘。
   * 以前只 clearTimeout，导致「切完 GPU 开关 400ms 内切走或退出」时改动被丢掉，
   * 下次启动读回旧值，看起来就是开关自己关了。
   */
  useEffect(() => {
    const onHide = (): void => flushSettings()
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      flushSettings()
    }
  }, [flushSettings])

  const handleSettingsChange = (patch: Partial<RenderSettings>): void => {
    const next = { ...settings, ...patch }
    setSettings(next)
    latestSettingsRef.current = next
    // GPU / 性能开关是显式用户意图：立即落盘，不等防抖
    if (['gpu', 'browserGpu', 'docker', 'workers'].some((key) => key in patch)) {
      persistSettings(next)
    }
  }

  /* --------------------------- 渲染事件 --------------------------- */

  useEffect(() => {
    const off = api().render.onEvent((event) => {
      if (event.type === 'logs') {
        if (event.lines.length === 0) {
          setLogs([])
          return
        }
        setLogs((prev) => {
          const next = [...prev, ...event.lines]
          return next.length > 6000 ? next.slice(next.length - 6000) : next
        })
      } else if (event.type === 'output-size') {
        setTask((prev) =>
          prev.id !== event.taskId
            ? prev
            : { ...prev, stats: { ...prev.stats, sizeBytes: event.bytes, sizeFinal: event.final } }
        )
      } else if (event.type === 'task') {
        setTask(event.task)
        // 任务结束（成功 / 失败 / 取消）后刷新历史：历史里存的是该任务自己的配置快照
        if (event.task.status === 'succeeded' || event.task.status === 'failed' || event.task.status === 'canceled') {
          void api()
            .render.history()
            .then(setTaskHistory)
            .catch(() => undefined)
        }
      }
    })
    return off
  }, [])

  /* --------------------------- 历史渲染配置 --------------------------- */

  useEffect(() => {
    let cancelled = false
    void api()
      .render.history()
      .then((entries) => {
        if (!cancelled) setTaskHistory(entries)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  /* --------------------------- 菜单事件 --------------------------- */  useEffect(() => {
    return api().onMenuOpenProject(() => void handleSelectProject())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* --------------------------- 快捷键 --------------------------- */

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && envOpen) {
        setEnvOpen(false)
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        void handleRender()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envOpen, settings, project, composition, outputDir, outputName, busy])

  /* ---------------------------- 项目 ---------------------------- */

  const applyProject = useCallback(
    async (info: ProjectInfo): Promise<void> => {
      setProject(info)
      if (bootSnapshot) bootSnapshot.project = info
      const files = await api().project.htmlFiles(info.path)
      setHtmlFiles(files)
      const stored = appSettingsRef.current?.lastOutputDir
      if (!stored) {
        setOutputDir(joinPath(info.path, 'renders'))
      }
      setOutputName((prev) => (prev.trim() ? prev : info.name))
    },
    []
  )

  const openProject = useCallback(
    async (
      path: string,
      options: { silent?: boolean; composition?: string | null } = {}
    ): Promise<void> => {
      setScanning(true)
      setProjectError(undefined)
      try {
        // 按当前渲染入口解析元数据：多 composition 项目不会把别的 composition 时长当成本项目
        const result = await api().project.scan(path, options.composition ?? null)
        if (!result.info) {
          if (!options.silent) {
            setProjectError(result.error ?? '无法读取项目')
            showToast(result.error ?? '无法读取项目', 'error')
          }
          setProject(null)
          return
        }
        await applyProject(result.info)
        const recentList = await api().project.recent()
        setRecent(recentList)
        appSettingsRef.current = await api().settings.get()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setProjectError(message)
        if (!options.silent) showToast(message, 'error')
      } finally {
        setScanning(false)
        // 保持 appSettingsRef 的最近输出目录同步
        const latest = await api().settings.get()
        appSettingsRef.current = latest
        setRecentOutputDirs(latest.recentOutputDirs)
      }
    },
    [applyProject, showToast]
  )

  const handleSelectProject = async (): Promise<void> => {
    setScanning(true)
    try {
      const result = await api().project.select()
      if (!result.info) {
        if (result.error) {
          setProjectError(result.error)
          showToast(result.error, 'error')
        }
        return
      }
      await applyProject(result.info)
      setRecent(await api().project.recent())
      appSettingsRef.current = await api().settings.get()
      setProjectError(undefined)
      showToast(`已打开项目 ${result.info.name}`)
    } finally {
      setScanning(false)
    }
  }

  const handleRescan = async (): Promise<void> => {
    if (!project) return
    await openProject(project.path, { composition })
    showToast('项目已重新检测')
  }

  /** 切换 composition：按新入口重新解析时长 / 分辨率 / FPS（走项目元数据缓存） */
  const handleCompositionChange = async (next: string): Promise<void> => {
    setComposition(next)
    if (!project) return
    await openProject(project.path, { composition: next || null, silent: true })
  }

  const handleRemoveRecent = async (path: string): Promise<void> => {
    setRecent(await api().project.removeRecent(path))
  }

  const handleRefreshFiles = async (): Promise<void> => {
    if (!project) return
    setHtmlFiles(await api().project.htmlFiles(project.path))
  }

  /* ---------------------------- 输出 ---------------------------- */

  const handleBrowseOutput = async (): Promise<void> => {
    const dir = await api().dialog.selectDirectory(outputDir || project?.path)
    if (dir) {
      setOutputDir(dir)
      const latest = await api().settings.get()
      appSettingsRef.current = latest
      setRecentOutputDirs(latest.recentOutputDirs)
    }
  }

  /* ---------------------------- 预设 ---------------------------- */

  const applyPreset = (preset: RenderPreset): void => {
    setSettings(preset.settings)
    setActivePresetId(preset.id)
    setPresetBaseline(preset.settings)
    showToast(`已应用预设「${preset.name}」`)
  }

  const savePreset = async (name: string): Promise<void> => {
    setPresets(await api().presets.save({ name, settings }))
    setPresetBaseline(settings)
    const list = await api().presets.list()
    const created = list.find((p) => p.name === name && !p.builtin)
    if (created) setActivePresetId(created.id)
    showToast(`预设「${name}」已保存`)
  }

  const updatePreset = async (preset: RenderPreset, name: string): Promise<void> => {
    setPresets(await api().presets.update(preset.id, { name, settings }))
    setPresetBaseline(settings)
    setActivePresetId(preset.id)
    showToast(`预设「${name}」已更新`)
  }

  const deletePreset = async (preset: RenderPreset): Promise<void> => {
    setPresets(await api().presets.remove(preset.id))
    if (activePresetId === preset.id) {
      setActivePresetId(null)
      setPresetBaseline(null)
    }
    showToast(`预设「${preset.name}」已删除`)
  }

  /* ---------------------------- 环境 ---------------------------- */

  const runEnvCheck = async (targetPath?: string): Promise<void> => {
    setEnvLoading(true)
    try {
      const report = await api().env.check(targetPath ?? project?.path)
      setEnv(report)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setEnvLoading(false)
    }
  }

  const runLint = async (): Promise<LintResult> => {
    if (!project) {
      return { ok: false, findings: [], error: '请先选择项目' }
    }
    try {
      return await api().project.lint(project.path)
    } catch (err) {
      return { ok: false, findings: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  /* ---------------------------- 渲染 ---------------------------- */

  const readiness = (): string | null => {
    if (!project) return '请先选择项目目录'
    if (!project.valid && !composition) return '项目缺少 index.html，请在高级参数中指定 composition 文件'
    if (exportMode === 'custom') {
      if (!outputDir.trim()) return '请选择输出位置'
      if (!outputName.trim()) return '请填写输出文件名'
    }
    if (settings.fpsMode === 'custom' && !settings.customFps.trim()) return '请填写自定义帧率'
    return null
  }

  const handleRender = async (): Promise<void> => {
    if (busy || starting) return
    const problem = readiness()
    if (problem || !project) {
      showToast(problem ?? '无法开始渲染', 'error')
      return
    }
    setStarting(true)
    try {
      const request = buildRequest(
        settings,
        project.path,
        composition,
        outputDir.trim(),
        outputName,
        project,
        exportMode
      )
      const result = await api().render.start(request)
      if (!result.ok) {
        showToast(result.error ?? '启动渲染失败', 'error')
        return
      }
      if (result.task) setTask(result.task)
      const latest = await api().settings.get()
      appSettingsRef.current = latest
      setRecentOutputDirs(latest.recentOutputDirs)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async (): Promise<void> => {
    setStopping(true)
    try {
      const result = await api().render.stop()
      if (!result.ok) showToast(result.error ?? '停止失败', 'error')
      else showToast('已发送停止信号，正在终止子进程', 'ok')
    } finally {
      setTimeout(() => setStopping(false), 1200)
    }
  }

  /** 停止前先弹确认框：误点一次会杀掉整棵子进程树，代价很高 */
  const requestStop = (): void => setStopConfirmOpen(true)

  const confirmStop = (): void => {
    setStopConfirmOpen(false)
    void handleStop()
  }

  // 弹窗打开期间渲染自己跑完了（或别处触发了停止），不留一个无意义的确认框
  useEffect(() => {
    if (!busy) setStopConfirmOpen(false)
  }, [busy])

  const handleClearLogs = async (): Promise<void> => {
    await api().render.clearLogs()
    setLogs([])
  }

  /* ---------------------------- 预览 ---------------------------- */

  const handlePreviewStart = async (): Promise<void> => {
    if (!project) {
      showToast('请先选择项目', 'error')
      return
    }
    const result = await preview.start()
    if (!result.ok) {
      showToast(result.error ?? '开启预览失败', 'error')
      return
    }
    if (!result.opened) {
      showToast(result.session?.error ?? '服务已就绪，但自动打开浏览器失败', 'error')
      return
    }
    showToast(result.reused ? '已复用运行中的预览服务，并打开 Studio' : '预览服务已启动，已打开 Studio')
  }

  const handlePreviewOpen = async (): Promise<void> => {
    const result = await preview.open()
    if (!result.ok) {
      showToast(result.error ?? '打开预览失败', 'error')
      return
    }
    if (!result.opened) {
      showToast(result.session?.error ?? '无法打开系统默认浏览器', 'error')
    }
  }

  const handlePreviewStop = async (): Promise<void> => {
    const result = await preview.stop()
    if (!result.ok) {
      showToast(result.error ?? '停止预览服务失败', 'error')
      return
    }
    showToast('预览服务已停止')
  }

  const handleExportModeChange = async (mode: ExportMode): Promise<void> => {
    if (mode === exportMode) return
    setExportMode(mode)
    const next = await api().settings.update({ exportMode: mode })
    appSettingsRef.current = next
    if (bootSnapshot) bootSnapshot.appSettings.exportMode = mode
    showToast(
      mode === 'project'
        ? '已切换到项目目录导出：文件保存到项目的 renders 文件夹'
        : '已切换到指定目录导出'
    )
  }

  const handlePickScratchDir = async (): Promise<void> => {
    const dir = await api().dialog.selectDirectory(scratchDir || frameCacheDefault || undefined)
    if (!dir) return
    const next = await api().settings.update({ scratchDir: dir })
    appSettingsRef.current = next
    setScratchDir(next.scratchDir)
    showToast('帧缓存目录已保存')
  }

  const handleUseSystemTemp = async (): Promise<void> => {
    const next = await api().settings.update({ scratchDir: '' })
    appSettingsRef.current = next
    setScratchDir('')
    showToast('已恢复 HyperFrames 默认帧缓存目录')
  }

  const handleAutoScratchChange = async (checked: boolean): Promise<void> => {
    const next = await api().settings.update({ autoScratch: checked })
    appSettingsRef.current = next
    setAutoScratch(next.autoScratch !== false)
  }

  // 项目目录模式展示默认 renders 目录；实际文件名由主进程按 CLI 规则生成
  const outputPath =
    exportMode === 'project'
      ? project
        ? joinPath(project.path, 'renders')
        : ''
      : outputDir
        ? joinPath(outputDir.trim(), `${outputName.trim() || 'render'}${EXTENSION_MAP[settings.format]}`)
        : ''

  const handleOpenOutput = async (): Promise<void> => {
    const target = task.stats.outputPath ?? outputPath
    if (!target) return
    try {
      await api().shell.openPath(target)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const handleRevealOutput = async (): Promise<void> => {
    const target = task.stats.outputPath ?? outputPath
    if (!target) return
    try {
      // 目录型输出（png-sequence / hls）直接打开目录；单文件输出定位到文件
      if (isDirectoryFormat(task.request?.format ?? settings.format)) {
        await api().shell.openPath(target)
      } else {
        await api().shell.showItem(target)
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const handleOpenOutputDir = async (): Promise<void> => {
    const target = task.request?.outputDir || outputDir
    if (!target) {
      showToast('尚未设置输出目录', 'error')
      return
    }
    try {
      await api().shell.openPath(target)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const handleSaveAppSettings = async (patch: {
    cliCommand?: string
    autoEnvCheck?: boolean
  }): Promise<void> => {
    const next = await api().settings.update(patch)
    appSettingsRef.current = next
    if (patch.cliCommand !== undefined) setCliCommand(next.cliCommand)
    if (patch.autoEnvCheck !== undefined) setAutoEnvCheck(next.autoEnvCheck)
    if (patch.cliCommand !== undefined) {
      showToast('CLI 命令已保存，正在重新检测环境')
      await runEnvCheck()
    }
  }

  const envStatus = envLoading ? 'unknown' : (env?.status ?? 'unknown')
  const blocked = readiness()
  const canRender = ready && !busy && !starting && !blocked

  // 设置读取完成前不渲染主界面，避免异步落地的旧参数覆盖用户操作
  if (!ready) {
    return (
      <div className="boot-screen">
        <div className="titlebar-drag-strip" aria-hidden />
        <div className="boot-center">
          <div className="brand-mark">HF</div>
          <Spinner />
          <span>正在读取本地设置…</span>
        </div>
      </div>
    )
  }

  return (
    <>
      <TitleBar
        envStatus={envStatus}
        envLoading={envLoading}
        onOpenEnv={() => {
          setEnvOpen(true)
          if (!env) void runEnvCheck()
        }}
        theme={props.theme}
        onToggleTheme={props.onToggleTheme}
        page={props.page}
        onNavigate={props.onNavigate}
        projectName={project?.name ?? null}
        projectPath={project?.path ?? null}
        projectValid={project?.valid}
        previewPort={preview.session?.status === 'running' ? preview.session.port : null}
        onOpenPreview={() => void handlePreviewOpen()}
      />

      <div className="workspace">
        <main className="pane-main">
          <ProjectSelector
            project={project}
            loading={scanning}
            error={projectError}
            recent={recent}
            composition={composition}
            onSelect={() => void handleSelectProject()}
            onRescan={() => void handleRescan()}
            onOpenRecent={(path) => void openProject(path)}
            onRemoveRecent={(path) => void handleRemoveRecent(path)}
            onReveal={() => project && void api().project.reveal(project.path)}
          />

          <PreviewStatus
            state={preview.state}
            session={preview.session}
            busy={preview.busy}
            hasProject={!!project}
            onStart={() => void handlePreviewStart()}
            onOpen={() => void handlePreviewOpen()}
            onStop={() => void handlePreviewStop()}
            onToast={showToast}
          />

          <PresetSelector
            presets={presets}
            activeId={activePresetId}
            dirty={dirty}
            disabled={busy}
            onApply={applyPreset}
            onSave={(name) => void savePreset(name)}
            onUpdate={(preset, name) => void updatePreset(preset, name)}
            onDelete={(preset) => void deletePreset(preset)}
          />

          <ExportSettings
            settings={settings}
            project={project}
            exportMode={exportMode}
            outputDir={outputDir}
            outputName={outputName}
            recentOutputDirs={recentOutputDirs}
            disabled={busy}
            onChange={handleSettingsChange}
            onExportModeChange={(mode) => void handleExportModeChange(mode)}
            onOutputDirChange={setOutputDir}
            onOutputNameChange={setOutputName}
            onBrowseOutput={() => void handleBrowseOutput()}
          />

          <AdvancedSettings
            settings={settings}
            project={project}
            composition={composition}
            htmlFiles={htmlFiles}
            disabled={busy}
            onChange={handleSettingsChange}
            onCompositionChange={(next) => void handleCompositionChange(next)}
            onRefreshFiles={() => void handleRefreshFiles()}
            onBrowseComposition={async () => {
              if (!project) return
              const picked = await api().dialog.selectComposition(project.path)
              if (picked) setComposition(picked)
            }}
            scratchDir={scratchDir}
            scratchDefault={frameCacheDefault}
            autoScratch={autoScratch}
            onPickScratchDir={() => void handlePickScratchDir()}
            onResetScratchDir={() => void handleUseSystemTemp()}
            onAutoScratchChange={(checked) => void handleAutoScratchChange(checked)}
          />

          <div className="action-bar">
            <div className="action-info">
              <div className="action-line">
                <span className="action-label">输出</span>
                <span className="action-path mono" title={outputPath}>
                  {outputPath || '尚未设置输出位置'}
                </span>
              </div>
              <div className="action-line small">
                <span className={blocked ? 'action-blocked' : 'action-ready'}>
                  {blocked ?? '准备就绪 · Ctrl + Enter 开始渲染'}
                </span>
              </div>
            </div>
            <div className="action-buttons">
              <PreviewButton
                phase={preview.phase}
                busy={preview.busy}
                error={preview.error}
                disabled={!project || !ready}
                onStart={() => void handlePreviewStart()}
                onOpen={() => void handlePreviewOpen()}
              />
              {busy ? (
                <Button variant="danger" onClick={requestStop} disabled={stopping}>
                  <span className="btn-icon">
                    <Icon.Stop />
                  </span>
                  {stopping ? '正在停止…' : '停止渲染'}
                </Button>
              ) : (
                <Button variant="primary" onClick={() => void handleRender()} disabled={!canRender}>
                  {starting ? <Spinner /> : <Icon.Play />}
                  开始渲染
                </Button>
              )}
            </div>
          </div>
        </main>

        <aside className="pane-side">
          <RenderProgress
            task={task}
            history={taskHistory}
            stopping={stopping}
            onStop={requestStop}
            onOpenOutput={() => void handleOpenOutput()}
            onRevealOutput={() => void handleRevealOutput()}
          />
          <ConsolePanel
            logs={logs}
            outputDir={outputDir}
            onClear={() => void handleClearLogs()}
            onOpenOutputDir={() => void handleOpenOutputDir()}
            onToast={showToast}
          />
        </aside>
      </div>

      <ConfirmDialog
        open={stopConfirmOpen}
        title="确定要停止渲染吗？"
        confirmText={stopping ? '正在停止…' : '停止渲染'}
        cancelText="继续渲染"
        tone="danger"
        busy={stopping}
        onCancel={() => {
          if (!stopping) setStopConfirmOpen(false)
        }}
        onConfirm={confirmStop}
      >
        <p>停止会立即终止渲染进程树，已经写入的临时文件不会保留。</p>
        <p className="modal-hint">停止后重新开始会从第 1 帧重新渲染，无法接着上次的进度继续。</p>
      </ConfirmDialog>

      <EnvDialog
        open={envOpen}
        report={env}
        loading={envLoading}
        projectPath={project?.path}
        cliCommand={cliCommand}
        autoEnvCheck={autoEnvCheck}
        onClose={() => setEnvOpen(false)}
        onRecheck={() => void runEnvCheck()}
        onLint={runLint}
        onSaveSettings={handleSaveAppSettings}
      />

      {toast && (
        <div className={`toast toast-${toast.tone}`} key={toast.id}>
          {toast.tone === 'ok' ? <Icon.Check /> : <Icon.Close />}
          {toast.message}
        </div>
      )}

      {!project && ready && (
        <div className="footer-hint">
          提示：渲染依赖本机的 Node.js 与 npx，首次调用 HyperFrames 会自动下载 CLI，需要网络连接。
        </div>
      )}
    </>
  )
}
