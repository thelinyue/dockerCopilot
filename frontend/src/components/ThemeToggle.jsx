import React from 'react'
import { Moon, Sun, Monitor } from 'lucide-react'
import { useTheme } from '../hooks/useTheme'
import { cn } from '../utils/cn'

export function ThemeToggle({ collapsed = false, mobile = false }) {
  const { theme, setTheme } = useTheme()

  const themes = [
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
    { value: 'system', label: '跟随系统', icon: Monitor },
  ]

  if (collapsed || mobile) {
    // 单图标入口直接循环切换，提示同时说明当前外观和下一次点击的结果。
    const currentIndex = themes.findIndex(item => item.value === theme)
    const currentTheme = themes[currentIndex]
    const nextTheme = themes[(currentIndex + 1) % themes.length]
    const Icon = currentTheme.icon
    
    return (
      <button
        type="button"
        aria-label={`外观，当前：${currentTheme.label}，点击切换为${nextTheme.label}`}
        onClick={() => setTheme(nextTheme.value)}
        className={cn('p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500', mobile && 'min-h-[44px] min-w-[44px] flex items-center justify-center gap-2 text-sm px-3 bg-gray-100 dark:bg-gray-700/60')}
        title={`当前：${currentTheme.label}，点击切换为${nextTheme.label}`}
      >
        <Icon aria-hidden="true" className="h-5 w-5" />
        {mobile && <span>{currentTheme.label}</span>}
      </button>
    )
  }

  return (
    <div role="group" aria-label="外观主题" className="theme-options flex items-center gap-0.5 bg-gray-100 dark:bg-gray-900/50 rounded-lg p-1">
      {themes.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={cn(
            'flex items-center justify-center gap-1.5 px-2.5 py-2 text-xs rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
            theme === value
              ? 'bg-white dark:bg-gray-700 text-primary-600 dark:text-primary-400 shadow-sm'
              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
          )}
          title={label}
        >
          <Icon aria-hidden="true" className="h-4 w-4 flex-shrink-0" />
          <span>{value === 'system' ? '系统' : label}</span>
        </button>
      ))}
    </div>
  )
}
