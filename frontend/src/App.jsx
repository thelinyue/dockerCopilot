import React, { useState, useEffect, useRef } from 'react'
import { Auth } from './components/Auth.jsx'
import { Sidebar, MobileBottomNav } from './components/Header.jsx'
import { Containers } from './components/Containers.jsx'
import { Images } from './components/Images.jsx'
import { Settings } from './components/Settings.jsx'
import { ThemeProvider } from './hooks/useTheme.jsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cn } from './utils/cn.js'

import { DeviceProvider } from './hooks/useDevice.jsx'
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
  const settingsBeforeLeave = useRef(null)
  const leaving = useRef(false)
  const [activeTab, setActiveTab] = useState('#compose')
  const [settingsSection, setSettingsSection] = useState('automation')
  const dirtyName = activeTab === '#settings' ? (settingsSection === 'notifications' ? '消息推送设置' : '更新设置') : '项目文件'
  const [containerScope, setContainerScope] = useState(null)
  const [composeTarget, setComposeTarget] = useState(null)
  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1024)
  const [userPreferredCollapsed, setUserPreferredCollapsed] = useState(false)
  const containerBatchRef = useRef(null)
  const [containerBatch, setContainerBatch] = useState(null)
  const pageActionsRef = useRef(null)
  const [pageActions, setPageActions] = useState(null)

  useEffect(() => {
    if (!isAuthenticated) queryClient.removeQueries({ predicate: query => ['iconBlob', 'customIcons'].includes(query.queryKey[1]) })
  }, [isAuthenticated])

  // 智能计算侧边栏是否应该收缩
  const getSmartCollapsedState = (width, userPreference) => {
    if (width < 768) {
      // 手机使用顶栏和底部导航，不渲染侧栏。
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
    setSettingsSection('automation')
    setDirty(false)
    setIsAuthenticated(true)
    // 触发自定义事件通知其他组件认证状态已更新
    window.dispatchEvent(new CustomEvent('authChange', { detail: { authenticated: true } }))
  }

  // 设置先排空自动保存，再沿用放弃修改确认；项目文件仍使用原来的显式保存保护。
  const prepareLeave = async (title, action) => {
    if (leaving.current) return false
    leaving.current = true
    try {
      const saved = settingsBeforeLeave.current ? await settingsBeforeLeave.current() : !dirty
      return saved || await confirm({ title, message: `${dirtyName}有尚未保存的修改，${action}后将丢失。`, confirmText: '放弃修改' })
    } finally { leaving.current = false }
  }

  const handleLogout = async () => {
    if (!await prepareLeave('退出登录', '退出')) return
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
    if (!await prepareLeave('离开当前页面', '离开')) return false
    setDirty(false)
    setContainerScope(null)
    setComposeTarget(null)
    setActiveTab(tab)
    return true
  }

  const handleSettingsSectionChange = async (section) => {
    if (section === settingsSection) return true
    if (!await prepareLeave('切换设置分类', '切换')) return false
    setDirty(false)
    setSettingsSection(section)
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
    if (id === deviceId) return true
    if (!await prepareLeave('切换设备', '切换')) return false
    setDirty(false)
    setContainerScope(null)
    setComposeTarget(null)
    setDeviceId(id)
    localStorage.setItem('docker_copilot_device', id)
    return true
  }

  const handleManageDevices = async () => {
    // 分别沿用页面和设置分类的离开确认，避免一次跳转重复询问。
    if (activeTab === '#settings') return handleSettingsSectionChange('devices')
    if (!await handleTabChange('#settings')) return false
    setSettingsSection('devices')
    return true
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
        return <Containers scope={containerScope} onClearScope={() => setContainerScope(null)} onOpenCompose={openCompose}
          mobileBatch={windowWidth < 768} batchRef={containerBatchRef} onBatchChange={setContainerBatch} />
      case '#images':
        return <Images mobileActions={windowWidth < 768} actionsRef={pageActionsRef} onActionsChange={setPageActions} />
      case '#compose':
        return <Compose onDirty={setDirty} initialTarget={composeTarget} onOpenContainers={openContainers}
          mobileActions={windowWidth < 768} actionsRef={pageActionsRef} onActionsChange={setPageActions} />
      case '#settings':
        return <Settings section={settingsSection} onSectionChange={handleSettingsSectionChange} onDirty={setDirty} beforeLeave={settingsBeforeLeave} />
      default:
        return <Compose onDirty={setDirty} initialTarget={composeTarget} onOpenContainers={openContainers}
          mobileActions={windowWidth < 768} actionsRef={pageActionsRef} onActionsChange={setPageActions} />
    }
  }

  if (!isAuthenticated) {
    return <Auth onLogin={handleLogin} />
  }

  return (
    <DeviceProvider deviceId={deviceId}>
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
        onManageDevices={handleManageDevices}
      />
      {/* 仅重建设备内容，导航保留以便关闭面板后恢复入口焦点。 */}
      <main key={deviceId} className={cn(
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
        <div className="flex-1 p-2 sm:p-4 lg:p-4 pt-2 sm:pt-4">
          {renderContent()}
        </div>
      </main>
      <MobileBottomNav
        key={`mobile-navigation-${deviceId}`}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        windowWidth={windowWidth}
        batch={activeTab === '#containers' && containerBatch ? {
          ...containerBatch,
          onEnter: () => containerBatchRef.current?.enter(),
          onExit: () => containerBatchRef.current?.exit(),
          onSelectAll: () => containerBatchRef.current?.selectAll(),
          onAction: action => containerBatchRef.current?.action(action),
        } : null}
        actions={pageActions?.page === activeTab ? {
          ...pageActions,
          onAction: id => pageActionsRef.current?.[id]?.(),
        } : null}
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
