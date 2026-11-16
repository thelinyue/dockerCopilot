// Adapted from LeiBox GlassTabMenu. Design reference: solutionb. See NOTICE.md.
import React from 'react'
import { CheckSquare2, Play, RotateCcw, Square, Upload, X } from 'lucide-react'
import { cn } from '../../../utils/cn.js'

export function handleBatchKeys(event, columns = 3) {
  const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')]
  const index = buttons.indexOf(document.activeElement)
  const offset = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key]
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : offset ? (index + offset + buttons.length) % buttons.length : -1
  if (next >= 0) { event.preventDefault(); buttons[next].focus({ preventScroll: true }) }
}

export function ContainerBatchActions({ selectedCount, totalCount, onSelectAll, onAction, onExit }) {
  const allSelected = totalCount > 0 && selectedCount === totalCount
  const actions = [
    { id: 'start', label: '启动', icon: Play, className: 'batch-glass-action-primary' },
    { id: 'stop', label: '停止', icon: Square },
    { id: 'restart', label: '重启', icon: RotateCcw },
    { id: 'update', label: '更新', icon: Upload },
  ]
  return <>
    <button type="button" className="batch-glass-action" disabled={!totalCount} aria-pressed={allSelected} aria-label={allSelected ? '取消全选' : '全选'} title={allSelected ? '取消全选' : '全选'} onClick={onSelectAll}>
      <CheckSquare2 aria-hidden="true" className="h-5 w-5" /><span>{allSelected ? '取消全选' : '全选'}</span>
      <span className="batch-glass-count">{selectedCount}/{totalCount}</span>
    </button>
    {actions.map(({ id, label, icon: Icon, className }) => <button key={id} type="button" aria-label={label} title={label} disabled={!selectedCount} className={cn('batch-glass-action', className)} onClick={() => onAction(id)}>
      <Icon aria-hidden="true" className="h-5 w-5" /><span>{label}</span>
    </button>)}
    <button type="button" aria-label="退出批量操作" title="退出批量操作" className="batch-glass-action" onClick={onExit}>
      <X aria-hidden="true" className="h-5 w-5" /><span>退出</span>
    </button>
  </>
}
