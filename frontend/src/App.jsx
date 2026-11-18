import React, { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { Auth } from './components/Auth.jsx'
import { Sidebar, MobileBottomNav, ApplicationPreferences } from './components/Header.jsx'
import { WorkspaceContext } from './hooks/useWorkspace.jsx'
import { BackNavigationProvider } from './hooks/useBackNavigation.jsx'
import { DeviceSelector } from './components/Devices.jsx'
import { Containers } from './components/Containers.jsx'
import { Images } from './components/Images.jsx'
import { Settings } from './components/Settings.jsx'
import { ThemeProvider } from './hooks/useTheme.jsx'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { deviceAPI } from './api/client.js'
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

function AppContent({ route, setRoute, navigate }) {
  const confirm = useConfirmation()
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem('docker_copilot_device') || 'local')
  const [dirty, setDirty] = useState(false)
  const settingsBeforeLeave = useRef(null)
  const leaving = useRef(false)
  const activeTab = route.tab
  const settingsSection = route.section
  const setActiveTab = tab => setRoute(previous => ({ ...previous, tab }))
  const setSettingsSection = section => setRoute(previous => ({ ...previous, section }))
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const views = useRef(new Map())
  const scrollPositions = useRef(new Map())
  const mainRef = useRef(null)
  const dirtyName = activeTab === '#settings' ? (settingsSection === 'notifications' ? '消息推送设置' : '更新设置') : '项目文件'
  const [containerScope, setContainerScope] = useState(null)
  const [composeTarget, setComposeTarget] = useState(null)
  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1024)
  const [userPreferredCollapsed, setUserPreferredCollapsed] = useState(false)
  const containerBatchRef = useRef(null)
  const [containerBatch, setContainerBatch] = useState(null)
  const { data: devices = [] } = useQuery({ queryKey: ['devices'], queryFn: deviceAPI.list, enabled: isAuthenticated })
  const deviceLabel = deviceId === 'local' ? '本机' : devices.find(device => device.id === deviceId)?.name || deviceId

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])

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
    scrollPositions.current.set(`${deviceId}:${activeTab}:${settingsSection}`, mainRef.current?.scrollTop || 0)
    setComposeTarget(null)
    setActiveTab(tab)
    return true
  }

  const handleSettingsSectionChange = async (section) => {
    if (section === settingsSection) return true
    if (!await prepareLeave('切换设置分类', '切换')) return false
    setDirty(false)
    scrollPositions.current.set(`${deviceId}:${activeTab}:${settingsSection}`, mainRef.current?.scrollTop || 0)
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
    scrollPositions.current.set(`${deviceId}:${activeTab}:${settingsSection}`, mainRef.current?.scrollTop || 0)
    setContainerBatch(null)
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

  navigate.current = async next => {
    if (next.tab !== activeTab && !await handleTabChange(next.tab)) return false
    if (next.tab === '#settings' && next.section !== settingsSection && !await handleSettingsSectionChange(next.section)) return false
    return true
  }
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = scrollPositions.current.get(`${deviceId}:${activeTab}:${settingsSection}`) || 0
  }, [deviceId, activeTab, settingsSection])

  const renderContent = () => {
    switch (activeTab) {
      case '#containers':
        return <Containers scope={containerScope} onClearScope={() => setContainerScope(null)} onOpenCompose={openCompose}
          batchRef={containerBatchRef} onBatchChange={setContainerBatch} />
      case '#images':
        return <Images />
      case '#compose':
        return <Compose onDirty={setDirty} initialTarget={composeTarget} onOpenContainers={openContainers} />
      case '#settings':
        return <Settings section={settingsSection} onSectionChange={handleSettingsSectionChange} onDirty={setDirty} beforeLeave={settingsBeforeLeave} />
      default:
        return <Compose onDirty={setDirty} initialTarget={composeTarget} onOpenContainers={openContainers} />
    }
  }

  if (!isAuthenticated) {
    return <Auth onLogin={handleLogin} />
  }

  return (
    <DeviceProvider deviceId={deviceId}>
    <WorkspaceContext.Provider value={{ deviceId, deviceLabel, online, mobile: windowWidth < 768, views, openPreferences: () => setPreferencesOpen(true), deviceTrigger: <DeviceSelector deviceId={deviceId} onChange={handleDeviceChange} onManageDevices={handleManageDevices} mobile={windowWidth < 768} header /> }}>
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
      <main ref={mainRef} key={deviceId} className={cn(
        "flex-1 min-w-0 flex flex-col transition-all duration-300",
        "workspace-main overflow-y-auto",
        windowWidth >= 768 && activeTab === '#containers' && containerBatch?.active && 'pb-16',
        "min-h-0",
        windowWidth < 768
          ? 'mobile-main'
          : windowWidth < 1024
            ? 'ml-20'
            : isSidebarCollapsed
              ? 'ml-20'
              : 'ml-56'
      )}>
        <div key={`${deviceId}:${activeTab}`} className="workspace-content flex-1 p-3 sm:p-5 lg:p-4 pt-0 sm:pt-0 lg:pt-0">
          {renderContent()}
        </div>
      </main>
      <MobileBottomNav
        key={`mobile-navigation-${deviceId}`}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        windowWidth={windowWidth}
        sidebarWidth={isSidebarCollapsed ? 80 : 224}
        batch={activeTab === '#containers' && containerBatch ? {
          ...containerBatch,
          onEnter: () => containerBatchRef.current?.enter(),
          onExit: () => containerBatchRef.current?.exit(),
          onSelectAll: () => containerBatchRef.current?.selectAll(),
          onAction: action => containerBatchRef.current?.action(action),
        } : null}

      />
      <ApplicationPreferences open={preferencesOpen} onClose={() => setPreferencesOpen(false)} onLogout={handleLogout} />
    </div>
    </WorkspaceContext.Provider>
    </DeviceProvider>
  )
}

function App() {
  const [route, setRoute] = useState({ tab: '#compose', section: 'automation' })
  const navigate = useRef(null)
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BackNavigationProvider route={route} onNavigate={next => navigate.current?.(next)}>
          <ConfirmationProvider>
            <AppContent route={route} setRoute={setRoute} navigate={navigate} />
          </ConfirmationProvider>
        </BackNavigationProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

export default App
