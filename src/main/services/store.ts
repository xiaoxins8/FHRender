import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 极简 JSON 持久化：存放在 Electron userData 目录，绝不写入用户项目目录。
 */
export class JsonStore<T extends object> {
  private readonly file: string
  private readonly defaults: T
  private cache: T | null = null
  /** 磁盘上真实出现过的键：用于区分「用户显式设置」与「默认值补全」 */
  private rawKeys: Set<string> | null = null

  constructor(fileName: string, defaults: T) {
    this.file = join(app.getPath('userData'), fileName)
    this.defaults = defaults
  }

  get path(): string {
    return this.file
  }

  async read(): Promise<T> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<T>
      this.rawKeys = new Set(Object.keys(parsed))
      this.cache = { ...this.defaults, ...parsed }
    } catch {
      this.rawKeys = new Set()
      this.cache = { ...this.defaults }
    }
    return this.cache
  }

  /** 该键是否真的写在磁盘文件里（而不是由 defaults 补出来的） */
  wasProvided(key: keyof T & string): boolean {
    return this.rawKeys?.has(key) ?? false
  }

  async write(value: T): Promise<T> {
    this.cache = value
    this.rawKeys = new Set(Object.keys(value))
    await fs.mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    const payload = JSON.stringify(value, null, 2)
    try {
      await fs.writeFile(tmp, payload, 'utf-8')
    } catch (err) {
      // Windows 上上次异常退出可能留下仍被句柄占用的 .tmp（EPERM / EBUSY / EACCES），
      // 清掉后重试一次；仍失败才把错误抛给调用方。
      if (!isTransientBusy(err)) throw err
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      await fs.writeFile(tmp, payload, 'utf-8')
    }
    await fs.rename(tmp, this.file)
    return value
  }

  async update(patch: Partial<T>): Promise<T> {
    const current = await this.read()
    return this.write({ ...current, ...patch })
  }
}

function isTransientBusy(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}
