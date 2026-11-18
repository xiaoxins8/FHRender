import type { ExportMode, RenderSettings } from './render'
import type { PerformanceMode } from './performance'

/** 导出参数预设（只保存在应用数据目录，不写入项目） */
export interface RenderPreset {
  id: string
  name: string
  /** 内置预设不可删除 */
  builtin: boolean
  /** 是否为改动过配置的用户预设 */
  settings: RenderSettings
  createdAt: string
  updatedAt: string
}

export interface PresetSaveInput {
  name: string
  settings: RenderSettings
}

export type ThemeMode = 'light' | 'dark' | 'system'

/** 主进程解析出的真实路径（只读，不写入设置文件） */
export interface AppPaths {
  /** HyperFrames 默认的提取帧缓存目录 */
  frameCacheDir: string
  /** 系统临时目录（磁盘捕获 workDir 的根） */
  tempRoot: string
  /** 默认值的来源说明 */
  frameCacheSource: string
}

export interface AppSettings {
  theme: ThemeMode
  recentProjects: { path: string; name: string; openedAt: string }[]
  recentOutputDirs: string[]
  lastOutputDir: string
  /** 导出位置模式：项目目录（CLI 默认 renders）或指定目录 */
  exportMode: ExportMode
  /** 记住上次使用的渲染参数 */
  lastSettings: RenderSettings | null
  lastComposition: string
  /** 启动时自动执行环境检测 */
  autoEnvCheck: boolean
  /** 自定义 CLI 命令（默认 npx --yes hyperframes） */
  cliCommand: string
  /** 当前性能模式 */
  performanceMode: PerformanceMode
  /** 极限模式下是否允许尝试实验性加速开关 */
  allowExperimental: boolean
  /**
   * 帧缓存目录（对应 CLI 的 --frames-cache-dir）。
   * 空字符串 = 使用 HyperFrames 默认值 `<tmpdir>/hyperframes-extract-cache-<uid>`。
   * 自定义时同时作为子进程的 TEMP / TMP 根目录（磁盘捕获的 workDir 也落在同一盘）。
   */
  scratchDir: string
  /** 系统临时目录剩余空间不足时，自动切换到空间更充裕的暂存盘 */
  autoScratch: boolean
  /* ---------------- 性能测试临时文件清理 ---------------- */
  /** 测试结束后自动清理本次产生的临时媒体文件（默认开启） */
  autoCleanPerfTests: boolean
  /** 保留失败测试现场（临时视频 / 中间文件），便于进一步调试（默认关闭） */
  keepFailedPerfTests: boolean
  /** 保留性能测试报告与日志（默认开启，长期保留） */
  keepPerfReports: boolean
}

export interface EnvironmentCheckItem {
  id: string
  label: string
  status: 'ok' | 'warning' | 'error' | 'unknown'
  detail: string
  hint?: string
}

export interface EnvironmentReport {
  checkedAt: string
  /** 汇总状态 */
  status: 'ok' | 'warning' | 'error'
  items: EnvironmentCheckItem[]
  /** CLI 原始 doctor 输出（供排查） */
  raw?: string
  cliVersion?: string
  nodeVersion?: string
  /** 机器级检查结果是否来自本地缓存（当前项目那一项始终实时判断） */
  fromCache?: boolean
}
