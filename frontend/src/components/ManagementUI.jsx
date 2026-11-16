import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle, Clock, LoaderCircle, RotateCw, X } from 'lucide-react'
import { cn } from '../utils/cn.js'
import { settingsErrorTarget } from '../utils/settings.js'

export function PageHeader({ title, children }) {
  return (
    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 pt-4 sm:pt-0">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{title}</h2>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

// 四个设置面板共用页头和分类导航，操作仍由各面板持有，避免重复标题和额外留白。
export function SettingsPanel({ navigation, scope, section, status, actions, children }) {
  return <>
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
      <div className="flex flex-1 items-center justify-between gap-3 min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-2xl font-bold flex-shrink-0">设置</h2>
          {scope && <span className="min-w-0 truncate text-xs sm:text-sm text-gray-500 dark:text-gray-400" title={scope}>{scope}</span>}
        </div>
        {status && <div className="flex-shrink-0 whitespace-nowrap">{status}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
    {navigation}
    <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${section}`}>{children}</div>
  </>
}

export function AutosaveStatus({ autosave }) {
  const failed = autosave.errors.length > 0
  const Icon = autosave.saving ? LoaderCircle : failed ? AlertCircle : autosave.dirty ? Clock : autosave.didSave ? CheckCircle : null
  return <span role="status" aria-live="polite" className={cn(
    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
    autosave.saving ? 'border-primary-100 bg-primary-50 text-primary-700 dark:border-primary-800 dark:bg-primary-900/20 dark:text-primary-300'
      : failed ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300'
        : 'border-gray-200 bg-white text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400'
  )}>
    {Icon && <Icon aria-hidden="true" className={cn('h-3.5 w-3.5 flex-shrink-0', autosave.saving && 'animate-spin motion-reduce:animate-none', !autosave.saving && !failed && !autosave.dirty && 'text-green-600 dark:text-green-400')} />}
    {autosave.saving ? '保存中…' : failed ? '保存失败' : autosave.dirty ? '等待自动保存…' : autosave.didSave ? '已保存' : '修改后自动保存'}
  </span>
}

export function AutosaveFeedback({ autosave, target, fields = [], id }) {
  const errors = autosave.errors.filter(error => target
    ? settingsErrorTarget(error) === target
    : !fields.includes(settingsErrorTarget(error)))
  if (!errors.length) return null
  return <div id={id} role="alert" className={cn(
    'flex items-start gap-2 text-sm',
    target ? 'text-red-600 dark:text-red-400' : 'rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3'
  )}>
    <AlertCircle aria-hidden="true" className={cn('h-4 w-4 flex-shrink-0 mt-1', !target && 'text-amber-600 dark:text-amber-400')} />
    <div className="min-w-0 flex-1 pt-0.5">
      {!target && <p className="font-medium text-gray-900 dark:text-gray-100">部分设置未保存</p>}
      <p className={cn('whitespace-pre-wrap break-words', !target && 'mt-1 text-gray-600 dark:text-gray-400')}>{[...new Set(errors.map(error => error.message))].join('\n')}</p>
    </div>
    <button type="button" disabled={autosave.saving} className="inline-flex items-center justify-center gap-1 flex-shrink-0 min-h-[44px] sm:min-h-8 px-2 rounded-lg text-xs font-medium text-primary-600 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50" onClick={() => { errors.forEach(error => { void autosave.retry(error.group) }) }}><RotateCw aria-hidden="true" className="h-3.5 w-3.5" />重试</button>
  </div>
}

export function UpdateBadge() {
  return <div role="img" aria-label="有可用更新" className="absolute -top-[2px] -right-[2px] w-[80px] h-[80px] pointer-events-none overflow-hidden z-20 rounded-tr-2xl">
    <div className="absolute top-0 right-0 w-full h-full flex items-center justify-center">
      <div className="absolute transform rotate-45 translate-x-[26px] -translate-y-[26px] w-[120px] h-[24px] bg-gradient-to-r from-yellow-400 to-yellow-500 dark:from-yellow-500 dark:to-yellow-600 shadow-sm flex items-center justify-center">
        <span className="relative text-[10px] font-bold text-white tracking-widest uppercase w-full text-center">
          NEW
          <span className="absolute top-0 left-0 animate-flow-light" />
        </span>
      </div>
    </div>
  </div>
}

export function Notice({ children, type = 'error', onClose }) {
  if (!children) return null
  const Icon = type === 'success' ? CheckCircle : AlertCircle
  return (
    <div role={type === 'success' ? 'status' : 'alert'} className={cn(
      'p-4 rounded-lg border flex items-start gap-3 text-sm',
      type === 'success' && 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-900 text-green-800 dark:text-green-200',
      type === 'warning' && 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200',
      type === 'error' && 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-900 text-red-800 dark:text-red-200'
    )}>
      <Icon className="h-5 w-5 flex-shrink-0" />
      <div className="flex-1 min-w-0 whitespace-pre-wrap break-words">{children}</div>
      {onClose && <button type="button" onClick={onClose} aria-label="关闭提示" className="flex-shrink-0 opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>}
    </div>
  )
}

// 新增管理操作沿用原有页内弹窗；键盘焦点留在弹窗中，关闭后回到触发位置。
export function Dialog({ title, onClose, children, className, id, open = true, onExited, placement = 'center', anchorRef, anchorSide = 'bottom' }) {
  const titleId = useId()
  const viewport = useRef(null)
  const panel = useRef(null)
  const close = useRef(onClose)
  const exited = useRef(onExited)
  const [present, setPresent] = useState(open)
  const [anchorStyle, setAnchorStyle] = useState({})
  const navigation = placement !== 'center'
  close.current = onClose
  exited.current = onExited

  // 导航面板先完成退场并交还焦点，再进入切设备、离开确认等后续流程。
  useLayoutEffect(() => {
    if (open) {
      setPresent(true)
      return
    }
    if (!present) return
    const timer = setTimeout(() => {
      setPresent(false)
      exited.current?.()
    }, navigation && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 200 : 0)
    return () => clearTimeout(timer)
  }, [open, present, navigation])

  useLayoutEffect(() => {
    if (!present || placement !== 'anchored') return
    const update = () => {
      const anchor = anchorRef?.current?.getBoundingClientRect()
      if (!anchor || !panel.current || !viewport.current) return
      const bounds = viewport.current.getBoundingClientRect()
      const padding = getComputedStyle(viewport.current)
      const leftEdge = bounds.left + parseFloat(padding.paddingLeft)
      const topEdge = bounds.top + parseFloat(padding.paddingTop)
      const rightEdge = bounds.right - parseFloat(padding.paddingRight)
      const bottomEdge = bounds.bottom - parseFloat(padding.paddingBottom)
      const width = Math.min(304, rightEdge - leftEdge)
      const height = Math.min(panel.current.getBoundingClientRect().height, bottomEdge - topEdge)
      let left = anchorSide === 'right' ? anchor.right + 8 : anchor.left
      let top = anchorSide === 'right' ? anchor.top : anchor.bottom + 8
      if (anchorSide === 'right' && left + width > rightEdge) left = anchor.left - width - 8
      if (anchorSide === 'bottom' && top + height > bottomEdge) top = anchor.top - height - 8
      setAnchorStyle({
        width,
        maxHeight: bottomEdge - topEdge,
        left: Math.max(leftEdge, Math.min(left, rightEdge - width)) - bounds.left,
        top: Math.max(topEdge, Math.min(top, bottomEdge - height)) - bounds.top,
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(panel.current)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [present, placement, anchorRef, anchorSide])

  // 在绘制前记录入口并接管焦点，避免快速按 Tab 时把背景按钮误记为返回位置。
  useLayoutEffect(() => {
    if (!present) return
    const previous = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () => Array.from(panel.current.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')).filter(item => item.getClientRects().length)
    const initial = panel.current.querySelector('[data-autofocus]') || focusable()[0]
    initial?.focus()
    const handleKey = event => {
      if (panel.current !== Array.from(document.querySelectorAll('[role="dialog"]')).at(-1)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close.current?.()
      } else if (event.key === 'Tab') {
        const items = focusable()
        const first = items[0]
        const last = items[items.length - 1]
        if (event.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', handleKey)
      if (previous?.isConnected) previous.focus()
    }
  }, [present])
  if (!present) return null
  const content = (
    <div ref={viewport} data-closing={!open || undefined} className={cn('modal-viewport z-[60]', navigation ? 'navigation-dialog' : 'bg-black bg-opacity-50', placement === 'sheet' && 'dialog-sheet', placement === 'anchored' && 'dialog-anchored')} onClick={event => { if (open && event.target === event.currentTarget) onClose?.() }}>
      <section id={id} ref={panel} inert={!open ? '' : undefined} role="dialog" aria-modal="true" aria-labelledby={titleId} style={placement === 'anchored' ? anchorStyle : undefined} className={cn('modal-panel bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-lg w-full text-gray-900 dark:text-gray-100', className)}>
        <div className={cn('border-b border-gray-200 dark:border-gray-700 flex justify-between items-center gap-3 flex-shrink-0', navigation ? 'px-4 py-2' : 'px-6 py-4')}>
          <h3 id={titleId} className="min-w-0 break-words text-lg font-medium text-gray-900 dark:text-white">{title}</h3>
          <button type="button" onClick={onClose} disabled={!onClose} aria-label="关闭对话框" className={cn('flex-shrink-0 text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 disabled:opacity-50', navigation && 'btn-icon-secondary flex items-center justify-center min-h-[44px] min-w-[44px]')}><X className="h-5 w-5" /></button>
        </div>
        {children}
      </section>
    </div>
  )
  // 侧栏的 transform 会改变 fixed 的定位容器；导航弹层挂到 body，避免裁切与偏移。
  return navigation ? createPortal(content, document.body) : content
}

const ConfirmationContext = createContext(null)

export function ConfirmationProvider({ children }) {
  const [request, setRequest] = useState(null)
  const resolve = useRef(null)
  const confirm = useCallback(options => new Promise(done => {
    resolve.current?.(false)
    resolve.current = done
    setRequest(options)
  }), [])
  const finish = useCallback(accepted => {
    setRequest(null)
    const done = resolve.current
    resolve.current = null
    done?.(accepted)
  }, [])
  useEffect(() => () => resolve.current?.(false), [])
  return (
    <ConfirmationContext.Provider value={confirm}>
      {children}
      {request && <Dialog title={request.title} onClose={() => finish(false)}>
        <div className="px-6 py-4 text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words">{request.message}</div>
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30 flex justify-end gap-3">
          <button type="button" className="btn-secondary" data-autofocus onClick={() => finish(false)}>取消</button>
          <button type="button" className={request.danger ? 'btn-danger' : 'btn-primary'} onClick={() => finish(true)}>{request.confirmText || '确认'}</button>
        </div>
      </Dialog>}
    </ConfirmationContext.Provider>
  )
}

export function useConfirmation() {
  return useContext(ConfirmationContext)
}
