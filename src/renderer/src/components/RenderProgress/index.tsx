import { useEffect, useState } from 'react'
import { Badge, Button, Icon, Panel, Spinner } from '../ui'
import { formatClock, formatDuration } from '../../services/api'
import { RenderTaskConfig } from './TaskConfig'
import type { EtaState, RenderHistoryEntry, RenderTaskState } from '@shared/types/render'

interface Props {
  task: RenderTaskState
  onStop: () => void
  onRevealOutput: () => void
  onOpenOutput: () => void
  stopping: boolean
  /** 历史渲染记录（来自主进程，与任务快照同源） */
  history?: RenderHistoryEntry[]
}

const STATUS_TEXT: Record<string, string> = {
  idle: '等待开始',
  preparing: '准备中',
  running: '渲染中',
  succeeded: '渲染完成',
  failed: '渲染失败',
  canceled: '已停止'
}

const RELIABILITY_TEXT: Record<string, string> = {
  high: '高可信度',
  medium: '一般可信度',
  estimating: '正在估算',
  stalled: '进度停滞',
  unavailable: '已结束'
}

/**
 * 剩余时间的显示文案。
 *
 * 这里只做「怎么展示」的决定，不参与计算：估算值本身由主进程的
 * RenderEtaEstimator 给出，界面不能靠 Math.max(1, eta) 之类的手段
 * 把不可用的估算伪装成一个数字。
 */
function etaText(task: RenderTaskState, eta: EtaState | null, busy: boolean): string {
  if (task.status === 'succeeded') return '已完成'
  if (!busy) return ''
  if (!eta) return '正在计算…'
  if (eta.stalled) return '等待渲染进度…'
  if (eta.etaMs == null) return '正在计算…'
  // 只有真的不足 1 秒才提示即将完成（不是把 ETA 强制设成 1 秒）
  if (eta.etaMs < 1000) return '即将完成…'
  return `预计剩余 ${formatDuration(eta.etaMs)}`
}

/** 字节数 → 人读大小（只用真实文件大小，不做任何按进度推算） */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 || value >= 100 ? 0 : 1)} ${units[index]}`
}

export function RenderProgress(props: Props): JSX.Element {
  const { task } = props
  const [now, setNow] = useState(Date.now())

  const busy = task.status === 'running' || task.status === 'preparing'

  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [busy])

  const elapsed =
    task.status === 'running' || task.status === 'preparing'
      ? task.startedAt
        ? now - new Date(task.startedAt).getTime()
        : 0
      : (task.elapsedMs ?? 0)

  const pct = task.progress.pct
  const determined = typeof pct === 'number'
  const outputPath = task.stats.outputPath
  const eta = busy ? (task.eta ?? null) : null
  // 结束后只有「成功」才显示已完成；失败 / 停止都不显示
  const showEtaLine = busy || task.status === 'succeeded'

  return (
    <Panel className="progress-panel" title="渲染状态">
      <div className="status-line">
        <span className={`status-pill status-${task.status}`}>
          {busy && <Spinner />}
          {STATUS_TEXT[task.status] ?? task.status}
        </span>
        <span className="status-time mono">
          {task.startedAt ? `开始 ${formatClock(task.startedAt)}` : '--:--:--'}
          {elapsed > 0 && ` · 已用 ${formatDuration(elapsed)}`}
        </span>
        {busy && (
          <Button size="sm" variant="danger" onClick={props.onStop} disabled={props.stopping}>
            <span className="btn-icon">
              <Icon.Stop />
            </span>
            {props.stopping ? '正在停止…' : '停止渲染'}
          </Button>
        )}
      </div>

      <div className="progress-block">
        <div className={`progress-track ${busy && !determined ? 'indeterminate' : ''}`}>
          <div
            className="progress-fill"
            style={determined ? { width: `${Math.max(0, Math.min(100, pct as number))}%` } : undefined}
          />
        </div>
        <div className="progress-meta">
          <span className="progress-label">{task.progress.label || '—'}</span>
          <span className="progress-pct mono">
            {determined ? `${Math.round(pct as number)}%` : busy ? '进行中' : '—'}
          </span>
        </div>
        <div className="progress-eta-line">
          {/*
           * done/total 的单位随阶段变化：
           * capture / encode 是帧，start_browsers 是 worker 数，assemble 是秒。
           * 以前一律写成「帧」，拼接阶段会出现「已完成 0 / 2 帧」这种误导。
           */}
          {typeof task.progress.done === 'number' &&
            typeof task.progress.total === 'number' &&
            (task.progress.code === 'capture' || task.progress.code === 'encode') && (
              <span className="progress-frames mono">
                已完成 {task.progress.done} / {task.progress.total} 帧
              </span>
            )}
          {typeof task.progress.done === 'number' &&
            task.progress.code === 'start_browsers' &&
            task.progress.total != null && (
              <span className="progress-frames mono">
                浏览器就绪 {task.progress.done} / {task.progress.total}
              </span>
            )}
          {showEtaLine && (
            <span className={`eta-remaining mono eta-${eta?.reliability ?? 'unavailable'}`}>
              {etaText(task, eta, busy)}
            </span>
          )}
        </div>

        {eta && (
          <div className="eta-grid">
            <div>
              <span className="metric-label">已运行</span>
              <span className="mono">{formatDuration(elapsed)}</span>
            </div>
            <div>
              <span className="metric-label">预计总耗时</span>
              <span className="mono">{eta.totalEstimateMs ? formatDuration(eta.totalEstimateMs) : '—'}</span>
            </div>
            <div>
              <span className="metric-label">预计完成时刻</span>
              <span className="mono">{eta.etaFinishAt ? formatClock(eta.etaFinishAt) : '—'}</span>
            </div>
            <div>
              <span className="metric-label">当前速度</span>
              <span className="mono">{eta.speedFps != null ? `${eta.speedFps.toFixed(2)} 帧/秒` : 'N/A'}</span>
            </div>
            <div>
              <span className="metric-label">估算可信度</span>
              <span className={`eta-reliability eta-${eta.reliability}`}>
                {RELIABILITY_TEXT[eta.reliability] ?? eta.reliability}
              </span>
            </div>
          </div>
        )}
        {eta?.note && <p className="muted-line eta-note">{eta.note}</p>}

        {/* 真实文件大小：每秒从磁盘读取，文件未生成时不显示伪造数字 */}
        {busy && (
          <div className="file-size-line">
            <span className="metric-label">当前文件大小</span>
            <span className="mono">
              {task.stats.sizeBytes != null ? `${formatBytes(task.stats.sizeBytes)}（写入中）` : '等待文件生成'}
            </span>
          </div>
        )}
      </div>

      {/* 进度条下方：当前渲染性能 / 当前导出配置（数据来自任务配置快照） */}
      <RenderTaskConfig
        config={task.config ?? null}
        history={props.history}
        showHistory={task.status !== 'running' && task.status !== 'preparing'}
      />

      {outputPath && (
        <div className="output-line">
          <span className="output-label">输出</span>
          <span className="output-path mono" title={outputPath}>
            {outputPath}
          </span>
          {task.status === 'succeeded' && (
            <span className="output-actions">
              <Button size="sm" variant="primary" className="btn-folder" onClick={props.onRevealOutput}>
                <Icon.Folder />
                打开文件夹
              </Button>
              <Button size="sm" variant="subtle" onClick={props.onOpenOutput}>
                打开文件
              </Button>
            </span>
          )}
        </div>
      )}

      {task.status === 'succeeded' &&
        (task.stats.sizeFinal || task.stats.sizeText || task.stats.durationText || task.stats.elapsedText) && (
          <div className="result-stats">
            {task.stats.sizeFinal && task.stats.sizeBytes != null && (
              <Badge tone="ok">最终文件大小 {formatBytes(task.stats.sizeBytes)}</Badge>
            )}
            {!task.stats.sizeFinal && task.stats.sizeText && <Badge tone="ok">{task.stats.sizeText}</Badge>}
            {task.stats.durationText && <Badge tone="info">{task.stats.durationText}</Badge>}
            {task.stats.elapsedText && <Badge tone="neutral">CLI 用时 {task.stats.elapsedText}</Badge>}
            {task.outputExists === false && <Badge tone="warn">未找到输出文件</Badge>}
          </div>
        )}

      {task.status === 'succeeded' && task.eta?.note && (
        <p className="muted-line">{task.eta.note}</p>
      )}

      {task.status === 'failed' && task.error && (
        <div className="alert alert-error">
          <strong>渲染失败</strong>
          <p>{task.error}</p>
        </div>
      )}

      {task.status === 'canceled' && (
        <div className="alert alert-warn">
          任务已被停止，未生成完成文件。相关子进程已一并终止，重新渲染将从第 1 帧开始。
        </div>
      )}

      {!task.startedAt && (
        <p className="muted-note">
          选择项目、确认参数后点击「开始渲染」。进度只来自 CLI 的真实输出，无法解析时不会显示虚假百分比。
        </p>
      )}
    </Panel>
  )
}
