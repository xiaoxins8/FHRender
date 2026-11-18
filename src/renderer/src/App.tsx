import { useCallback, useEffect, useState } from 'react'
import { Home } from './pages/Home'
import { Performance } from './pages/Performance'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ConfirmDialog } from './components/ui'
import type { PageId, ResolvedTheme } from './pages/types'
import { api } from './services/api'

export default function App(): JSX.Element {
  const [page, setPage] = useState<PageId>('render')
  const [theme, setTheme] = useState<ResolvedTheme>('light')
  /** 主进程请求的退出确认（rendering = 当前是否有渲染任务） */
  const [exitAsk, setExitAsk] = useState<{ rendering: boolean } | null>(null)

  // 退出确认：标题栏 X / Alt+F4 / 菜单退出 / Cmd+Q 都统一走这里
  useEffect(() => {
    return api().app.onCloseRequest((payload) => {
      setExitAsk({ rendering: payload?.rendering === true })
    })
  }, [])

  const answerExit = useCallback((confirmed: boolean): void => {
    setExitAsk(null)
    void api().app.confirmExit(confirmed)
  }, [])

  useEffect(() => {
    let cancelled = false
    void api()
      .settings.get()
      .then((settings) => {
        if (cancelled) return
        const resolved =
          settings.theme === 'system'
            ? window.matchMedia?.('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : 'light'
            : settings.theme
        setTheme(resolved)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.style.colorScheme = theme
    // 同步原生窗口按钮（titleBarOverlay）的配色，避免深色栏配浅色图标
    void api().window.setTheme(theme)
  }, [theme])

  useEffect(() => {
    let cancelled = false
    void api()
      .window.getState()
      .then((state) => {
        if (cancelled) return
        document.documentElement.dataset.platform = state.platform
        document.documentElement.dataset.maximized = String(state.maximized)
      })
      .catch(() => undefined)
    const off = api().window.onState((state) => {
      document.documentElement.dataset.maximized = String(state.maximized)
      document.documentElement.dataset.fullscreen = String(state.fullscreen)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const toggleTheme = useCallback((): void => {
    setTheme((prev) => {
      const next: ResolvedTheme = prev === 'dark' ? 'light' : 'dark'
      void api().settings.update({ theme: next })
      return next
    })
  }, [])

  return (
    <div className="app">
      <ErrorBoundary resetKey={page}>
        {page === 'render' ? (
          <Home theme={theme} onToggleTheme={toggleTheme} page={page} onNavigate={setPage} />
        ) : (
          <Performance theme={theme} onToggleTheme={toggleTheme} page={page} onNavigate={setPage} />
        )}
      </ErrorBoundary>

      <ConfirmDialog
        open={exitAsk !== null}
        title="确定要退出 HF Render 吗？"
        confirmText="退出"
        cancelText="取消"
        tone="danger"
        onConfirm={() => answerExit(true)}
        onCancel={() => answerExit(false)}
      >
        {exitAsk?.rendering ? (
          <>
            <p>当前有渲染任务正在运行，退出会立即终止该任务。</p>
            <p className="modal-hint">未完成的渲染不会保留任何进度，下次需要从头开始。</p>
          </>
        ) : (
          <p>退出后需要重新启动应用。</p>
        )}
      </ConfirmDialog>
    </div>
  )
}
