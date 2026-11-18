import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppPaths } from '@shared/types/settings'

/**
 * HyperFrames 的「提取帧缓存」默认目录。
 *
 * CLI 源码里的默认值是 `<os.tmpdir()>/hyperframes-extract-cache-<uid>`，
 * Windows 没有 getuid()，uid 固定为 "u"。这里只做一次同步计算并缓存，
 * 页面切换 / 重复打开设置时直接读缓存，不跑任何环境检测或 CLI 探测。
 */
let cached: AppPaths | null = null

export function resolveAppPaths(): AppPaths {
  if (cached) return cached
  const tempRoot = tmpdir()
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'u'
  cached = {
    tempRoot,
    frameCacheDir: join(tempRoot, `hyperframes-extract-cache-${uid}`),
    frameCacheSource: 'HyperFrames CLI 默认值（<tmpdir>/hyperframes-extract-cache-<uid>）'
  }
  return cached
}

/** 本次渲染实际使用的帧缓存目录：自定义优先，否则就是 CLI 默认目录 */
export function effectiveFramesCacheDir(custom: string | null | undefined): {
  dir: string
  custom: boolean
} {
  const trimmed = (custom ?? '').trim()
  if (trimmed) return { dir: trimmed, custom: true }
  return { dir: resolveAppPaths().frameCacheDir, custom: false }
}
