import React from 'react'
import { Clock, Network, Box, Bell } from 'lucide-react'
import { cn } from '../utils/cn.js'
import { Automation } from './Automation.jsx'
import { Devices } from './Devices.jsx'
import { Icons } from './Icons.jsx'
import { Notifications } from './Notifications.jsx'

const sections = [
  { id: 'automation', label: '更新设置', shortLabel: '更新设置', icon: Clock },
  { id: 'notifications', label: '消息推送', shortLabel: '通知', icon: Bell },
  { id: 'devices', label: '设备管理', shortLabel: '设备', icon: Network },
  { id: 'icons', label: '图标库', shortLabel: '图标', icon: Box },
]

export function Settings({ section, onSectionChange, onDirty, beforeLeave }) {
  const scope = section === 'devices' ? '主端接入列表' : undefined

  const select = async id => {
    const accepted = await onSectionChange(id)
    // 切换内容会卸载原面板；新面板渲染后把焦点交还分类按钮。
    requestAnimationFrame(() => document.getElementById(`settings-tab-${accepted ? id : section}`)?.focus({ preventScroll: true }))
  }
  const navigation = <div role="tablist" aria-label="设置分类" className="grid grid-cols-4 sm:flex gap-1 p-1 mb-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
    {sections.map(({ id, label, shortLabel, icon: Icon }, index) => <button
      key={id}
      id={`settings-tab-${id}`}
      type="button"
      role="tab"
      aria-label={label}
      aria-selected={section === id}
      aria-controls="settings-panel"
      tabIndex={section === id ? 0 : -1}
      className={cn('min-w-0 min-h-[44px] flex items-center justify-center gap-2 px-1 sm:px-4 text-sm font-medium rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
        section === id ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50')}
      onClick={() => select(id)}
      onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % sections.length
          : event.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : -1
        if (next < 0) return
        event.preventDefault()
        select(sections[next].id)
      }}
    >
      <Icon aria-hidden="true" className="hidden sm:block h-4 w-4 flex-shrink-0" />
      <span className="sm:hidden whitespace-nowrap">{shortLabel}</span>
      <span className="hidden sm:inline whitespace-nowrap">{label}</span>
    </button>)}
  </div>
  const layout = { navigation, scope, section }

  return <div className="max-w-7xl mx-auto px-2 sm:px-6 py-2 sm:py-4 text-gray-900 dark:text-gray-100">
    {section === 'automation' && <Automation layout={layout} onDirty={onDirty} beforeLeave={beforeLeave} />}
    {section === 'notifications' && <Notifications layout={layout} onDirty={onDirty} beforeLeave={beforeLeave} />}
    {section === 'devices' && <Devices layout={layout} />}
    {section === 'icons' && <Icons layout={layout} />}
  </div>
}
