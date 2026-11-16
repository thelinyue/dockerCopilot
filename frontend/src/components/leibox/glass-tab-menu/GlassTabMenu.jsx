// Adapted from LeiBox GlassTabMenu. Design reference: solutionb. See NOTICE.md.
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { mountGlassTabDock } from './GlassTabMenuEngine.js'
import { ContainerBatchActions, handleBatchKeys } from './ContainerBatchActions.jsx'
import './glass-tab-menu.css'

export function GlassTabMenu({ items, activeTab, onTabChange, batch, actions }) {
  const navigation = useRef(null)
  const toggle = useRef(null)
  const menu = useRef(null)
  const motion = useRef(null)
  const [expanded, setExpanded] = useState(false)
  const menuId = useId()
  const hasActions = Boolean(batch || actions?.items.length)
  const toggleLabel = batch ? '批量操作' : actions?.label
  const closeLabel = batch ? '收起批量菜单' : `收起${toggleLabel}`

  useLayoutEffect(() => {
    const controller = mountGlassTabDock(navigation.current)
    motion.current = controller
    return () => { controller.destroy(); motion.current = null }
  }, [])

  // 操作摘要在页面挂载后发布；加号出现会缩短导航，须按最终宽度重新定位选中块。
  // 仍只跟随已确认的页面状态，取消离开时不会提前切换。
  useLayoutEffect(() => { motion.current?.select(); setExpanded(false) }, [activeTab, hasActions])
  useLayoutEffect(() => { motion.current?.setOpen(expanded) }, [expanded])
  useLayoutEffect(() => { if (!hasActions || batch?.active === false) setExpanded(false) }, [hasActions, batch?.active])
  useEffect(() => {
    if (!expanded) return
    const dismiss = event => { if (!navigation.current.contains(event.target)) setExpanded(false) }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [expanded])

  const close = (returnFocus = false) => {
    if (returnFocus) toggle.current?.focus({ preventScroll: true })
    setExpanded(false)
  }
  const open = (focus = false) => {
    batch?.onEnter()
    setExpanded(true)
    if (focus) requestAnimationFrame(() => menu.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true }))
  }

  return <div ref={navigation} className="mobile-bottom-nav glass-tab-dock" data-motion-component="glass-tab-menu" data-has-actions={hasActions ? 'true' : undefined} data-expanded={expanded}
    onBlur={event => { if (expanded && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close() }}
    onKeyDown={event => {
      if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close(true) }
    }}>
    <div className="glass-tab-surface">
      <nav aria-label="手机导航" className="glass-nav-tabs" aria-hidden={expanded || undefined} inert={expanded ? '' : undefined} onKeyDown={event => {
        const buttons = [...event.currentTarget.querySelectorAll('button')]
        const index = buttons.indexOf(document.activeElement)
        const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length
          : event.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1
        if (next >= 0) { event.preventDefault(); buttons[next].focus({ preventScroll: true }) }
      }}>
        <span className="glass-nav-selection" aria-hidden="true" />
        <span className="glass-nav-lens" aria-hidden="true" />
        {items.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-label={label} title={label} aria-current={activeTab === id ? 'page' : undefined} className="glass-nav-tab" onClick={() => onTabChange(id)}>
          <Icon aria-hidden="true" className="h-5 w-5 flex-shrink-0" /><span>{label}</span>
        </button>)}
      </nav>
      {hasActions && <div ref={menu} id={menuId} role="group" aria-label={batch ? '批量容器操作' : actions.label} className={`glass-actions-grid ${batch ? 'glass-batch-grid' : 'glass-page-actions'}`} style={batch ? undefined : { '--glass-action-columns': actions.items.length }} aria-hidden={!expanded} inert={expanded ? undefined : ''} onKeyDown={event => handleBatchKeys(event, batch ? 3 : actions.items.length)}>
        {batch ? <ContainerBatchActions selectedCount={batch.selectedCount} totalCount={batch.totalCount} onSelectAll={batch.onSelectAll}
          onAction={action => { close(true); batch.onAction(action) }} onExit={() => { close(true); batch.onExit() }} />
          : actions.items.map(({ id, label, ariaLabel = label, icon: Icon, disabled, busy }) => <button key={id} type="button" aria-label={ariaLabel} title={ariaLabel} disabled={disabled} aria-busy={busy || undefined} className="batch-glass-action" onClick={() => { close(true); actions.onAction(id) }}>
            <Icon aria-hidden="true" className={`h-5 w-5${busy ? ' animate-spin' : ''}`} /><span>{label}</span>
          </button>)}
      </div>}
    </div>
    {hasActions && <button ref={toggle} type="button" className="glass-dock-toggle" aria-label={expanded ? closeLabel : toggleLabel} title={expanded ? closeLabel : batch?.active ? `批量操作，已选 ${batch.selectedCount} 项` : toggleLabel} aria-pressed={batch?.active} aria-expanded={expanded} aria-controls={menuId} aria-describedby={batch?.active ? `${menuId}-selection` : undefined}
      onClick={event => { if (expanded) close(); else open(event.detail === 0) }}
      onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); open(true) } }}>
      <Plus aria-hidden="true" className="glass-dock-plus h-6 w-6" />
      {batch?.active && <span aria-hidden="true" className="batch-selection-count">{batch.selectedCount}</span>}
      {batch?.active && <span id={`${menuId}-selection`} className="sr-only" aria-live="polite">已选 {batch.selectedCount} 个容器，共 {batch.totalCount} 个</span>}
    </button>}
  </div>
}
