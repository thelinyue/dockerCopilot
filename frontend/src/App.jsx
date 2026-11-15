import React, { useState, useEffect } from 'react'
import { Auth } from './components/Auth.jsx'
import { Sidebar, MobileBottomNav } from './components/Header.jsx'
import { Containers } from './components/Containers.jsx'
import { Images } from './components/Images.jsx'
import { Icons } from './components/Icons.jsx'
import { About } from './components/About.jsx'
import { ThemeProvider } from './hooks/useTheme.jsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cn } from './utils/cn.js'

import { DeviceProvider } from './hooks/useDevice.jsx'
import { Devices } from './components/Devices.jsx'
import { Automation } from './components/Automation.jsx'
import { Compose } from './components/Compose.jsx'
import { ConfirmationProvider, useConfirmation } from './components/ManagementUI.jsx'

// 创建一个全局的QueryClient实例
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

function AppContent() {
  const confirm = useConfirmation()
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem('docker_copilot_device') || 'local')
  const [dirty, setDirty] = useState(false)
  const [activeTab, setActiveTab] = useState('#compose')
  const [containerScope, setContainerScope] = useState(null)
  const [composeTarget, setComposeTarget] = useState(null)
  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1024)
  const [userPreferredCollapsed, setUserPreferredCollapsed] = useState(false)

  // 智能计算侧边栏是否应该收缩
  const getSmartCollapsedState = (width, userPreference) => {
    if (width < 768) {
      // 手机模式：不在乎收缩状态，菜单模式处理
      return false
    } else if (width < 1024) {
      // 平板模式：强制收缩，忽略用户偏好
      return true
    } else {
      // 桌面模式：使用用户偏好
      return userPreference
    }
  }

  const isSidebarCollapsed = getSmartCollapsedState(windowWidth, userPreferredCollapsed)

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    const update = () => {
      root.style.setProperty('--visual-viewport-height', `${viewport.height}px`)
      root.style.setProperty('--visual-viewport-top', `${viewport.offsetTop}px`)
      // 地址栏伸缩不视为键盘；用户主动缩放时也不隐藏导航。
      root.classList.toggle('keyboard-open', viewport.scale === 1 && window.innerHeight - viewport.height > 150)
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      root.style.removeProperty('--visual-viewport-height')
      root.style.removeProperty('--visual-viewport-top')
      root.classList.remove('keyboard-open')
    }
  }, [])

  useEffect(() => {
    // 检查本地存储中是否有token
    const token = localStorage.getItem('docker_copilot_token')
    if (token) {
      setIsAuthenticated(true)
    }

    // 监听storage事件，当其他标签页修改localStorage时更新认证状态
    const handleStorageChange = (e) => {
      if (e.key === 'docker_copilot_token') {
        if (e.newValue) {
          setIsAuthenticated(true)
        } else {
          setIsAuthenticated(false)
        }
      }
    }

    window.addEventListener('storage', handleStorageChange)

    // 监听自定义事件，用于在本标签页中处理认证状态变化
    const handleAuthChange = (e) => {
      if (e.detail.authenticated) {
        setIsAuthenticated(true)
      } else {
        setIsAuthenticated(false)
      }
    }

    window.addEventListener('authChange', handleAuthChange)

    // 监听窗口大小变化
    const handleResize = () => {
      const width = window.innerWidth
      setWindowWidth(width)
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('authChange', handleAuthChange)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  const handleLogin = () => {
    setActiveTab('#compose')
    setIsAuthenticated(true)
    // 触发自定义事件通知其他组件认证状态已更新
    window.dispatchEvent(new CustomEvent('authChange', { detail: { authenticated: true } }))
  }

  const handleLogout = async () => {
    if (dirty && !await confirm({ title: '退出登录', message: '项目文件有未保存的修改，退出后将丢失。', confirmText: '退出登录' })) return
    setDirty(false)
    setContainerScope(null)
    setComposeTarget(null)
    localStorage.removeItem('docker_copilot_token')
    setIsAuthenticated(false)
    // 触发自定义事件通知其他组件认证状态已更新
    window.dispatchEvent(new CustomEvent('authChange', { detail: { authenticated: false } }))
  }

  const handleTabChange = async (tab) => {
    if (tab === activeTab) {
      if (tab === '#containers') setContainerScope(null)
      return true
    }
    if (dirty && !await confirm({ title: '离开当前页面', message: '项目文件有未保存的修改，离开后将丢失。', confirmText: '放弃修改' })) return false
    setDirty(false)
    setContainerScope(null)
    setComposeTarget(null)
    setActiveTab(tab)
    return true
  }

  // 联动只携带当前设备的项目位置，不用项目名猜测其他设备上的对象。
  const openCompose = async (container) => {
    if (await handleTabChange('#compose')) setComposeTarget(container || null)
  }
  const openContainers = async (scope) => {
    if (await handleTabChange('#containers')) setContainerScope(scope)
  }

  const handleDeviceChange = async (id) => {
    if (id === deviceId) return
    if (dirty && !await confirm({ title: '切换设备', message: '项目文件有未保存的修改，切换后将丢失。', confirmText: '放弃并切换' })) return
    setDirty(false)
    setContainerScope(null)
    setComposeTarget(null)
    setDeviceId(id)
    localStorage.setItem('docker_copilot_device', id)
  }

  const handleToggleCollapse = () => {
    // 只有在桌面模式下才允许手动切换
    if (windowWidth >= 1024) {
      setUserPreferredCollapsed(!userPreferredCollapsed)
    }
  }

  const renderContent = () => {
    switch (activeTab) {
      case '#containers':
        return <Containers scope={containerScope} onClearScope={() => setContainerScope(null)} onOpenCompose={openCompose} />
      case '#images':
        return <Images />
      case '#icons':
        return <Icons />
      case '#compose':
        return <Compose onDirty={setDirty} initialTarget={composeTarget} onOpenContainers={openContainers} />
      case '#automation':
        return <Automation />
      case '#devices':
        return <Devices />
      case '#about':
        return <About />
      default:
        return <Compose onDirty={setDirty} initialTarget={composeTarget} onOpenContainers={openContainers} />
    }
  }

  if (!isAuthenticated) {
    return <Auth onLogin={handleLogin} />
  }

  return (
    <DeviceProvider key={deviceId} deviceId={deviceId}>
    <div className="app-shell flex bg-gray-50 dark:bg-gray-900 transition-colors duration-300 flex-col lg:flex-row">
      <Sidebar
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onLogout={handleLogout}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={handleToggleCollapse}
        windowWidth={windowWidth}
        deviceId={deviceId}
        onDeviceChange={handleDeviceChange}
      />
      <main className={cn(
        "flex-1 min-w-0 flex flex-col transition-all duration-300",
        "overflow-y-auto",
        "min-h-0",
        windowWidth < 768
          ? 'mobile-main'
          : windowWidth < 1024
            ? 'ml-20'
            : isSidebarCollapsed
              ? 'ml-20'
              : 'ml-64'
      )}>
        <div className="flex-1 p-2 sm:p-4 lg:p-4 pt-4 sm:pt-4">
          {renderContent()}
        </div>
      </main>
      <MobileBottomNav
        activeTab={activeTab}
        onTabChange={handleTabChange}
        windowWidth={windowWidth}
      />
    </div>
    </DeviceProvider>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ConfirmationProvider>
          <AppContent />
        </ConfirmationProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

export default App
