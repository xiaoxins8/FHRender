import { promises as fs, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { VideoFormat } from '@shared/types/render'

/** 目录型输出里算作正式产物的文件后缀（临时文件 / 缓存 / 日志一律不计） */
const DIRECTORY_EXTENSIONS: Record<string, string[]> = {
  'png-sequence': ['.png'],
  hls: ['.m3u8', '.ts', '.m4s', '.mp4', '.aac']
}

const IGNORED_SUFFIXES = ['.tmp', '.part', '.crdownload', '.log', '.json', '.lock', '.bak']

export interface OutputSizeResult {
  /** 实际字节数；文件不存在 / 读取失败时为 null */
  bytes: number | null
  /** 计入的文件数（目录型输出用） */
  files: number
}

function shouldCount(fileName: string, format: VideoFormat | undefined): boolean {
  const lower = fileName.toLowerCase()
  if (lower.startsWith('.') || lower.startsWith('~')) return false
  if (IGNORED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false
  const allowed = format ? DIRECTORY_EXTENSIONS[format] : undefined
  if (!allowed) return true
  return allowed.some((ext) => lower.endsWith(ext))
}

/**
 * 读取输出文件 / 目录的真实大小。
 *
 * - 单文件：直接 stat
 * - 目录型输出（png-sequence / hls）：只累加正式产物后缀，跳过隐藏文件与临时文件
 * - 文件被占用 / 尚未生成 / 路径不存在：返回 null，绝不抛错影响渲染任务
 */
export async function measureOutputSize(
  target: string,
  format?: VideoFormat
): Promise<OutputSizeResult> {
  if (!target) return { bytes: null, files: 0 }
  try {
    const stat = await fs.stat(target)
    if (stat.isFile()) return { bytes: stat.size, files: 1 }
    if (!stat.isDirectory()) return { bytes: null, files: 0 }

    let bytes = 0
    let files = 0
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.')) continue
          await walk(full)
          continue
        }
        if (!entry.isFile() || !shouldCount(entry.name, format)) continue
        try {
          const info = await fs.stat(full)
          bytes += info.size
          files += 1
        } catch {
          /* 单个文件被占用时跳过，不影响整体统计 */
        }
      }
    }
    await walk(target)
    return { bytes, files }
  } catch {
    return { bytes: null, files: 0 }
  }
}
