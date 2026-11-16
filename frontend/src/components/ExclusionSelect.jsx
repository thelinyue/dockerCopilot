import React, { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'
import { cn } from '../utils/cn.js'

export function ExclusionSelect({ label, options, onChange, disabled, loading, error }) {
  const id = useId()
  const root = useRef(null)
  const trigger = useRef(null)
  const search = useRef(null)
  const [open, setOpen] = useState(false)
  const [upward, setUpward] = useState(false)
  const [keyword, setKeyword] = useState('')
  const selected = options.filter(option => option.selected)
  const summary = selected.length ? `已选 ${selected.length} 项` : '未选择'
  const filtered = options.filter(option => `${option.label} ${option.detail || ''}`.toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase()))
  const remove = option => onChange(option, false)
  const toggle = option => {
    if (option.disabled) return
    onChange(option, !option.selected)
  }
  const show = () => {
    if (open) { setOpen(false); return }
    const rect = trigger.current.getBoundingClientRect()
    setUpward(window.innerHeight - rect.bottom < 280 && rect.top > window.innerHeight - rect.bottom)
    setKeyword('')
    setOpen(true)
  }
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = event => { if (!root.current.contains(event.target)) setOpen(false) }
    const escape = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    root.current.addEventListener('keydown', escape)
    const element = root.current
    return () => {
      document.removeEventListener('pointerdown', outside)
      element.removeEventListener('keydown', escape)
    }
  }, [open])
  return (
    <div ref={root} className="min-w-0 space-y-2" onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      <div className="relative">
        <button ref={trigger} id={id} type="button" disabled={disabled} aria-label={`选择${label}`} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? `${id}-options` : undefined} className="input flex items-center justify-between gap-3 text-sm text-left disabled:opacity-50" onClick={show} onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); show() } }}>
          <span className={selected.length ? '' : 'text-gray-500 dark:text-gray-400'}>{summary}</span>
          <ChevronDown className={cn('h-4 w-4 flex-shrink-0 text-gray-400 transition-transform', open && 'rotate-180')} />
        </button>
        {open && <div id={`${id}-options`} role="dialog" aria-label={label} className={cn('absolute left-0 right-0 z-30 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg flex flex-col overflow-hidden max-h-[min(20rem,50dvh)]', upward ? 'bottom-full mb-2' : 'top-full mt-2')}>
          <div className="flex-shrink-0 p-2 border-b border-gray-200 dark:border-gray-700">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
              <input ref={search} type="search" aria-label={`搜索${label}`} placeholder="搜索" className="input pl-9 text-sm" value={keyword} onChange={event => setKeyword(event.target.value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); root.current.querySelector('input[type="checkbox"]:not(:disabled)')?.focus() } }} />
            </div>
          </div>
          {error && <p role="alert" className="p-3 text-xs text-red-600 dark:text-red-400 break-words">{error.message}</p>}
          <div className="p-1 min-h-0 overflow-y-auto" data-options-list>
            {filtered.map(option => <label key={option.value} className={cn('flex items-center gap-3 px-3 py-2 rounded-lg transition-colors', option.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700')}>
              <input type="checkbox" disabled={disabled || option.disabled} className="h-4 w-4 flex-shrink-0 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700" checked={option.selected} onChange={() => toggle(option)} />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm" title={option.label}>{option.label}</span>{option.detail && <span className="block truncate text-xs text-gray-500 dark:text-gray-400 mt-0.5" title={option.detail}>{option.detail}</span>}</span>
            </label>)}
            {!filtered.length && <p className="text-center text-sm text-gray-500 dark:text-gray-400 py-4">{loading ? '加载中…' : keyword ? '无匹配项' : '暂无可选项'}</p>}
          </div>
          {!!selected.length && <div className="flex-shrink-0 p-2 border-t border-gray-200 dark:border-gray-700"><button type="button" disabled={disabled} className="w-full text-left px-3 py-2 text-sm text-gray-600 dark:text-gray-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50" onClick={() => onChange(null, false)}>清空选择</button></div>}
        </div>}
      </div>
      {!!selected.length && <div className="flex flex-wrap gap-2">
        {selected.map(option => <span key={option.value} className="inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded-lg text-xs bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300">
          <span className="truncate" title={option.label}>{option.label}</span>
          <button type="button" disabled={disabled} aria-label={`取消排除 ${option.label}`} title="移除" className="flex-shrink-0 rounded hover:bg-primary-100 dark:hover:bg-primary-900 disabled:opacity-50" onClick={() => remove(option)}><X className="h-3.5 w-3.5" /></button>
        </span>)}
      </div>}
    </div>
  )
}
