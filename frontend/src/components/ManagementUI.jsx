import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle, Clock, LoaderCircle, MoreHorizontal, Palette, RotateCw, X } from 'lucide-react'
import { cn } from '../utils/cn.js'
import { settingsErrorTarget } from '../utils/settings.js'
import { useWorkspace } from '../hooks/useWorkspace.jsx'
import { useBackLayer } from '../hooks/useBackNavigation.jsx'

export function PageHeader({ title, meta, children, className, menu = [], selection, status }) {
  const workspace = useWorkspace()
  return (
    <><header className={cn('workspace-header', className)}>
      {selection?.active ? <>
        <button type="button" className="page-action" onClick={selection.onExit}>取消</button>
        <h2 className="flex-1 text-center text-base font-semibold" aria-live="polite">已选 {selection.selectedCount} 项</h2>
        <button type="button" className="page-action action-accent" disabled={!selection.totalCount} onClick={selection.onSelectAll}>{selection.selectedCount === selection.totalCount && selection.totalCount ? '取消全选' : '全选'}</button>
      </> : <>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <h2 className="shrink-0 text-xl font-semibold leading-6">{title.replace('管理', '')}</h2>
          <div className="flex min-w-0 items-center gap-1">
            {workspace?.deviceTrigger}
            {workspace?.online === false && <span role="status" className="shrink-0 text-xs text-amber-700 dark:text-amber-400">离线</span>}
          </div>
          {meta && <div className="hidden lg:flex min-w-0 flex-1">{meta}</div>}
        </div>
        {status}
        <div role="group" aria-label={`${title}操作`} className="flex items-center gap-1 shrink-0">
          {children}
          {menu.length > 0 && <ActionMenu title={`${title.replace('管理', '')}操作`} items={menu} triggerClassName="page-action action-icon" />}
        </div>
      </>}
    </header><div className="workspace-header-space" /></>
  )
}

export function ActionMenu({ title = '更多操作', items, disabled, label, icon: Icon = MoreHorizontal, triggerRef, triggerClassName }) {
  const workspace = useWorkspace()
  const localTrigger = useRef(null)
  const trigger = triggerRef || localTrigger
  const [open, setOpen] = useState(false)
  const afterClose = useRef(null)
  const id = useId()
  return <>
    <button
      ref={trigger}
      type="button"
      className={triggerClassName || cn(label ? 'btn-secondary gap-1.5' : 'btn-icon-secondary', 'disabled:opacity-40')}
      aria-label={label || title}
      title={title}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      disabled={disabled}
      onClick={event => { event.stopPropagation(); setOpen(true) }}
    >
      {Icon && <Icon aria-hidden="true" className="h-5 w-5" />}
      {label}
    </button>
    <Dialog id={id} title={title} open={open} placement={workspace?.mobile ? 'sheet' : 'anchored'} anchorRef={trigger} anchorAlign="end" actionMenu onClose={() => setOpen(false)} onExited={() => { const action = afterClose.current; afterClose.current = null; action?.() }}>
      <div className="action-menu-items" onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const entries = Array.from(event.currentTarget.querySelectorAll('button:not(:disabled), a[href]:not([aria-disabled="true"])'))
        if (!entries.length) return
        event.preventDefault()
        const current = entries.indexOf(document.activeElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length
        entries[next].focus()
      }}>
        {items.filter(Boolean).map((item, index) => {
          const Tag = item.href ? 'a' : 'button'
          return <React.Fragment key={item.id || index}>
            {item.separator && index > 0 && <div role="separator" className="action-menu-separator" />}
            <Tag type={item.href ? undefined : 'button'} href={item.href} target={item.href ? '_blank' : undefined} rel={item.href ? 'noopener noreferrer' : undefined} aria-disabled={item.disabled || undefined} tabIndex={item.disabled ? -1 : undefined} className={cn('action-menu-item', item.danger && 'text-red-600 dark:text-red-400')} disabled={item.disabled} onClick={event => {
              event.stopPropagation()
              if (item.disabled) { event.preventDefault(); return }
              afterClose.current = item.onClick
              setOpen(false)
            }}>
              {item.icon && <item.icon aria-hidden="true" className="h-4 w-4 shrink-0" />}<span className="flex-1">{item.label}</span>{item.count !== undefined && <span className="text-xs text-gray-500 tabular-nums">{item.count}</span>}
            </Tag>
          </React.Fragment>})}
      </div>
    </Dialog>
  </>
}

export function ResourceFilters({ items, value, onChange }) {
  return <div role="group" aria-label="资源筛选" className="resource-filters">
    {items.map(item => <button key={item.id ?? 'all'} type="button" aria-pressed={value === item.id} className={cn('resource-filter', value === item.id && 'resource-filter-active')} onClick={() => onChange(item.id)}><span>{item.label.replace(/^总项目$|^总容器$/, '全部')}</span><span className="tabular-nums opacity-65">{item.count}</span></button>)}
  </div>
}

export function ConnectionNotice({ error, hasData, retry, busy }) {
  const workspace = useWorkspace()
  if (!error && workspace?.online !== false) return null
  return <Notice type="warning"><div className="flex items-start gap-2"><span className="flex-1">{hasData ? '连接中断，显示上次数据。' : '无法连接设备。'}{error?.message || '请检查网络连接。'}</span><button type="button" className="underline shrink-0 min-h-[44px]" disabled={busy || workspace?.online === false} onClick={retry}>重试</button></div></Notice>
}

export function Toast({ children, onClose }) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (children) { const timer = setTimeout(() => close.current?.(), 3200); return () => clearTimeout(timer) }
  }, [children])
  if (!children) return null
  return createPortal(<div className="workspace-toast" role="status"><CheckCircle aria-hidden="true" className="h-4 w-4 shrink-0 text-green-500" /><span>{children}</span><button type="button" aria-label="关闭提示" onClick={onClose} className="btn-icon-secondary"><X className="h-4 w-4" /></button></div>, document.body)
}

// 四个设置面板共用页头和分类导航，操作仍由各面板持有，避免重复标题和额外留白。
export function SettingsPanel({ navigation, section, status, actions, menu = [], children }) {
  const workspace = useWorkspace()
  return <>
    <PageHeader title="设置" status={status} menu={[...menu, { label: '外观与关于', icon: Palette, separator: true, onClick: workspace?.openPreferences }]}>{actions}</PageHeader>
    {navigation}
    <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${section}`}>{children}</div>
  </>
}

export function AutosaveStatus({ autosave }) {
  const [recent, setRecent] = useState(false)
  useEffect(() => {
    if (!autosave.didSave || autosave.saving || autosave.dirty) return
    setRecent(true)
    const timer = setTimeout(() => setRecent(false), 2200)
    return () => clearTimeout(timer)
  }, [autosave.didSave, autosave.saving, autosave.dirty])
  const failed = autosave.errors.length > 0
  if (!autosave.saving && !failed && !autosave.dirty && !recent) return null
  const Icon = autosave.saving ? LoaderCircle : failed ? AlertCircle : autosave.dirty ? Clock : autosave.didSave ? CheckCircle : null
  return <span role="status" aria-live="polite" className={cn(
    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
    autosave.saving ? 'border-primary-100 bg-primary-50 text-primary-700 dark:border-primary-800 dark:bg-primary-900/20 dark:text-primary-300'
      : failed ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300'
        : 'border-gray-200 bg-white text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400'
  )}>
    {Icon && <Icon aria-hidden="true" className={cn('h-3.5 w-3.5 flex-shrink-0', autosave.saving && 'animate-spin motion-reduce:animate-none', !autosave.saving && !failed && !autosave.dirty && 'text-green-600 dark:text-green-400')} />}
    {autosave.saving ? '保存中' : failed ? '保存失败' : autosave.dirty ? '待保存' : '已保存'}
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
export function Dialog({ title, onClose, children, className, id, open = true, onExited, placement = 'center', anchorRef, anchorSide = 'bottom', anchorAlign = 'start', actionMenu = false, mobileFullScreen = false }) {
  const titleId = useId()
  const viewport = useRef(null)
  const panel = useRef(null)
  const close = useRef(onClose)
  const exited = useRef(onExited)
  const [present, setPresent] = useState(open)
  const [anchorStyle, setAnchorStyle] = useState({})
  const navigation = placement !== 'center'
  const compactMenu = actionMenu && placement === 'anchored'
  close.current = onClose
  exited.current = onExited
  useBackLayer(open, onClose)

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
    }, navigation && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? compactMenu ? 120 : 200 : 0)
    return () => clearTimeout(timer)
  }, [open, present, navigation, compactMenu])

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
      const width = Math.min(compactMenu ? 224 : 304, rightEdge - leftEdge)
      const height = Math.min(panel.current.getBoundingClientRect().height, bottomEdge - topEdge)
      let left = anchorSide === 'right' ? anchor.right + 8 : anchorAlign === 'end' ? anchor.right - width : anchor.left
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
  }, [present, placement, anchorRef, anchorSide, anchorAlign, compactMenu])

  // 在绘制前记录入口并接管焦点，避免快速按 Tab 时把背景按钮误记为返回位置。
  useLayoutEffect(() => {
    if (!present) return
    const previous = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () => Array.from(panel.current.querySelectorAll('button:not(:disabled), a[href]:not([aria-disabled="true"]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')).filter(item => item.getClientRects().length)
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
    <div ref={viewport} data-closing={!open || undefined} className={cn('modal-viewport z-[60]', navigation ? 'navigation-dialog' : 'bg-black bg-opacity-50', placement === 'sheet' && 'dialog-sheet', placement === 'anchored' && 'dialog-anchored', compactMenu && 'action-menu-dialog')} onClick={event => { if (open && event.target === event.currentTarget) onClose?.() }}>
      <section id={id} ref={panel} inert={!open ? '' : undefined} role="dialog" aria-modal="true" aria-labelledby={titleId} style={placement === 'anchored' ? anchorStyle : undefined} className={cn('modal-panel bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-lg w-full text-gray-900 dark:text-gray-100', mobileFullScreen && 'mobile-fullscreen-panel', className)}>
        <div className={cn(compactMenu ? 'sr-only' : 'dialog-heading border-b border-gray-200 dark:border-gray-700 flex justify-between items-center gap-3 flex-shrink-0', !compactMenu && (navigation ? 'px-4 py-2' : 'px-6 py-4'))}>
          <h3 id={titleId} title={title} className={cn('min-w-0 font-medium text-gray-900 dark:text-white', navigation ? 'truncate text-base' : 'break-words text-lg')}>{title}</h3>
          {!compactMenu && <button type="button" onClick={onClose} disabled={!onClose} aria-label="关闭对话框" className="btn-icon-secondary flex items-center justify-center min-h-[44px] min-w-[44px] shrink-0 disabled:opacity-50"><X className="h-5 w-5" /></button>}
        </div>
        {children}
      </section>
    </div>
  )
  // 侧栏的 transform 会改变 fixed 的定位容器；导航弹层挂到 body，避免裁切与偏移。
  return createPortal(content, document.body)
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
