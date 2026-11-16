// Adapted from LeiBox GlassTabMenu. Design reference: solutionb. See NOTICE.md.
import React, { useEffect, useId, useRef, useState } from 'react'
import { ListChecks } from 'lucide-react'
import { cn } from '../../../utils/cn.js'
import { mountGlassTabMenu } from './GlassTabMenuEngine.js'
import { ContainerBatchActions, handleBatchKeys } from './ContainerBatchActions.jsx'
import './glass-tab-menu.css'

export function ContainerBatchMenu({ active, selectedCount, totalCount, onEnter, onExit, onSelectAll, onAction }) {
  const trigger = useRef(null)
  const panel = useRef(null)
  const id = useId()
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const element = panel.current
    const motion = mountGlassTabMenu(element)
    const position = () => {
      const anchor = trigger.current.getBoundingClientRect()
      const viewport = window.visualViewport
      const left = viewport?.offsetLeft || 0
      const top = viewport?.offsetTop || 0
      const width = viewport?.width || window.innerWidth
      const height = viewport?.height || window.innerHeight
      element.style.width = `${Math.min(288, width - 24)}px`
      element.style.maxHeight = `${height - 24}px`
      element.style.left = `${Math.max(left + 12, Math.min(anchor.right - element.offsetWidth, left + width - element.offsetWidth - 12))}px`
      const below = anchor.bottom + 8
      const above = anchor.top - element.offsetHeight - 8
      element.style.top = `${Math.max(top + 12, Math.min(below + element.offsetHeight <= top + height - 12 ? below : above, top + height - element.offsetHeight - 12))}px`
    }
    const beforeToggle = event => {
      const open = event.newState === 'open'
      // 收起时立即移出键盘导航，原生 Popover 负责外部点击和 Escape 关闭。
      element.inert = !open
      setExpanded(open)
      motion.setOpen(open)
      if (!open && element.contains(document.activeElement)) trigger.current.focus({ preventScroll: true })
    }
    const toggle = event => { if (event.newState === 'open') position() }
    const reposition = () => { if (element.matches(':popover-open')) position() }
    element.addEventListener('beforetoggle', beforeToggle)
    element.addEventListener('toggle', toggle)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    return () => {
      motion.destroy()
      element.removeEventListener('beforetoggle', beforeToggle)
      element.removeEventListener('toggle', toggle)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
    }
  }, [])

  useEffect(() => { if (!active) panel.current.hidePopover() }, [active])

  const show = (focus = false) => {
    if (!active) onEnter()
    panel.current.showPopover()
    if (focus) panel.current.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
  }
  const close = () => panel.current.hidePopover()

  return <>
    <button ref={trigger} type="button" aria-label="批量操作" title={active ? `批量操作，已选 ${selectedCount} 项` : '批量操作'} aria-pressed={active} aria-expanded={expanded} aria-controls={id} aria-describedby={active ? `${id}-selection` : undefined}
      className={cn('btn-secondary page-action relative', active && 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300')}
      onClick={event => { if (panel.current.matches(':popover-open')) close(); else show(event.detail === 0) }}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); show(true) } }}>
      <ListChecks aria-hidden="true" className="h-4 w-4" /><span className="hidden sm:inline">批量操作</span>
      {active && <span aria-hidden="true" className="batch-selection-count">{selectedCount}</span>}
      {active && <span id={`${id}-selection`} className="sr-only" aria-live="polite">已选 {selectedCount} 个容器，共 {totalCount} 个</span>}
    </button>
    <div ref={panel} id={id} popover="auto" role="group" aria-label="批量容器操作" className="batch-glass-menu"
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close() }}
      onKeyDown={handleBatchKeys}>
      <ContainerBatchActions selectedCount={selectedCount} totalCount={totalCount} onSelectAll={onSelectAll}
        onAction={action => { close(); onAction(action) }} onExit={() => { close(); onExit() }} />
    </div>
  </>
}
