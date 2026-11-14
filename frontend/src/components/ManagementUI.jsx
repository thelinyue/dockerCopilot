import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, CheckCircle, X } from 'lucide-react'
import { cn } from '../utils/cn.js'

export function PageHeader({ title, children }) {
  return (
    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 pt-4 sm:pt-0">
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{title}</h2>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
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
export function Dialog({ title, onClose, children, className }) {
  const titleId = useId()
  const panel = useRef(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () => Array.from(panel.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]'))
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
  }, [])
  return (
    <div className="modal-viewport bg-black bg-opacity-50 z-[60]" onClick={event => { if (event.target === event.currentTarget) onClose?.() }}>
      <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cn('modal-panel bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-lg w-full text-gray-900 dark:text-gray-100', className)}>
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center gap-3">
          <h3 id={titleId} className="min-w-0 break-words text-lg font-medium text-gray-900 dark:text-white">{title}</h3>
          <button type="button" onClick={onClose} disabled={!onClose} aria-label="关闭对话框" className="flex-shrink-0 text-gray-400 hover:text-gray-500 dark:hover:text-gray-300 disabled:opacity-50"><X className="h-5 w-5" /></button>
        </div>
        {children}
      </section>
    </div>
  )
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
