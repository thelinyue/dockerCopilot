import React from 'react'
import {
  Box,
  LogOut,
  Server,
  Boxes, Settings, Github, MessageSquare, MoreHorizontal
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { deviceAPI } from '../api/client.js'
import { DeviceSelector } from './Devices.jsx'
import { Dialog } from './ManagementUI.jsx'
import { ThemeToggle } from './ThemeToggle.jsx'
import { UpdatePrompt } from './UpdatePrompt.jsx'
import { cn } from '../utils/cn.js'
import logoImg from '../assets/DockerCopilot-logo.png'
import { useVersionCheck } from '../hooks/useVersionCheck.js'

const navItems = [
  { id: '#compose', label: '项目', icon: Boxes },
  { id: '#containers', label: '容器', icon: Server },
  { id: '#images', label: '镜像', icon: Box },
  { id: '#settings', label: '设置', icon: Settings },
]

export function Sidebar({ activeTab, onTabChange, onLogout, isCollapsed = false, onToggleCollapse, windowWidth = 1024, deviceId, onDeviceChange, onManageDevices }) {
  const [moreOpen, setMoreOpen] = React.useState(false)
  const afterMoreClose = React.useRef(null)
  const moreId = React.useId()
  const { data: devices = [] } = useQuery({ queryKey: ['devices'], queryFn: deviceAPI.list })
  const deviceName = deviceId === 'local' ? '本机' : devices.find(device => device.id === deviceId)?.name || '设备不可用'

  // 时间格式转换函数 - 将UTC时间转换为北京时间
  const formatVersionBuildDate = (dateString) => {
    try {
      const date = new Date(dateString)
      if (isNaN(date.getTime())) {
        return dateString
      }

      // 转换为北京时间 (UTC+8)
      const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000)

      return beijingDate.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).replace(/\//g, '-')
    } catch (error) {
      return dateString
    }
  }

  // 使用版本检查 Hook
  const {
    showUpdatePrompt,
    isUpdating,
    setShowUpdatePrompt,
    backendVersion,
    remoteVersion,
    buildDate,
    hasBackendUpdate,
    versionError,
    updateBackend
  } = useVersionCheck()

  // 智能判断是否可以手动切换侧边栏
  const canToggleSidebar = windowWidth >= 1024
  const isTabletSize = windowWidth >= 768 && windowWidth < 1024
  const isMobileSize = windowWidth < 768

  const closeMore = action => {
    if (!moreOpen) return
    afterMoreClose.current = typeof action === 'function' ? action : null
    setMoreOpen(false)
  }
  React.useEffect(() => {
    afterMoreClose.current = null
    setMoreOpen(false)
  }, [isMobileSize])

  const versionInfo = <div className="space-y-2 text-xs text-gray-500 dark:text-gray-400">
    <div className="flex items-start justify-between gap-3">
      <span className="flex-shrink-0 pt-0.5">当前版本</span>
      <span className="min-w-0 text-right break-all text-sm font-semibold text-gray-900 dark:text-white">{backendVersion || '加载版本…'}</span>
    </div>
    {buildDate && <p title={formatVersionBuildDate(buildDate)}>构建 {formatVersionBuildDate(buildDate).split(' ')[0]}</p>}
    {hasBackendUpdate && <button type="button" onClick={() => {
      if (isMobileSize) closeMore(() => setShowUpdatePrompt(true))
      else setShowUpdatePrompt(true)
    }} className="min-h-[44px] text-amber-700 dark:text-amber-300 font-medium">有新版本 →</button>}
    {versionError && <p className="text-amber-600 dark:text-amber-400 break-words">版本检查不可用：{versionError}</p>}
  </div>

  const projectLinks = (compact = false) => <nav aria-label="项目链接" className={cn('flex gap-2', compact ? 'flex-col' : 'items-center')}>
    <a href="https://github.com/thelinyue/dockerCopilot" target="_blank" rel="noopener noreferrer" className={cn('btn min-h-[44px] whitespace-nowrap text-xs bg-gray-900 text-white hover:bg-gray-800 focus:ring-gray-500', compact ? 'w-full flex-col gap-1 px-1' : 'flex-1 gap-1.5 px-2')}>
      <Github aria-hidden="true" className="h-4 w-4 flex-shrink-0" /><span>项目源码</span>
    </a>
    <a href="https://github.com/thelinyue/dockerCopilot/issues" target="_blank" rel="noopener noreferrer" className={cn('btn min-h-[44px] whitespace-nowrap text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/50 focus:ring-blue-500', compact ? 'w-full flex-col gap-1 px-1' : 'flex-1 gap-1.5 px-2')}>
      <MessageSquare aria-hidden="true" className="h-4 w-4 flex-shrink-0" /><span>问题反馈</span>
    </a>
  </nav>

  const handleToggleCollapse = () => {
    // 只在桌面模式允许切换
    if (canToggleSidebar && onToggleCollapse) {
      onToggleCollapse()
    }
  }

  return (
    <>
      {isMobileSize && (
        <div className="mobile-header fixed top-0 left-0 right-0 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between z-40 shadow-sm">
          <div className="flex items-center gap-1 min-w-0 flex-1 mr-1">
            <img src={logoImg} alt="Docker Copilot" className="h-7 w-7 flex-shrink-0 rounded-lg object-cover" />
            <DeviceSelector deviceId={deviceId} onChange={onDeviceChange} onManageDevices={onManageDevices} mobile />
          </div>
          <div className="flex items-center flex-shrink-0">
            <ThemeToggle mobile />
            <button type="button" aria-label="更多" aria-haspopup="dialog" aria-expanded={moreOpen} aria-controls={moreOpen ? moreId : undefined} onClick={() => setMoreOpen(true)} className="btn-icon-secondary min-h-[44px] min-w-[44px] flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500" title="更多">
              <MoreHorizontal aria-hidden="true" className="h-5 w-5" />
            </button>
            <button type="button" aria-label="退出登录" onClick={onLogout} className="btn-icon-error min-h-[44px] min-w-[44px] flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500" title="退出登录">
              <LogOut aria-hidden="true" className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      {isMobileSize && <div className="flex-shrink-0" style={{ height: 'var(--mobile-header-height)' }} />}

      <Dialog id={moreId} title="更多" open={moreOpen} onClose={() => closeMore()} placement="sheet" onExited={() => {
        const action = afterMoreClose.current
        afterMoreClose.current = null
        action?.()
      }}>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-4 space-y-5">
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-3">
            <p className="text-sm font-medium mb-3 break-words">{deviceName}</p>
            {versionInfo}
          </div>
          {projectLinks()}
        </div>
      </Dialog>

      {/* 侧边栏 */}
      {!isMobileSize && <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 bg-white dark:bg-gray-800 shadow-xl lg:shadow-none transform transition-all duration-300 ease-in-out flex flex-col",
          isCollapsed ? "w-20" : "w-64",
          "overflow-y-auto",
          "border-r border-gray-200 dark:border-gray-700"
        )}
      >
        <div className="flex flex-col min-h-full">
          {/* 桌面品牌入口沿用原有的展开、收起操作。 */}
            <div className="p-4 sm:p-5 flex-shrink-0">
              <button
                onClick={handleToggleCollapse}
                disabled={!canToggleSidebar}
                className={cn(
                  "w-full flex items-center transition-all duration-300 group",
                  !canToggleSidebar ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:opacity-80",
                  isCollapsed ? "justify-center" : "space-x-3"
                )}
                title={
                  isTabletSize ? "平板模式（自动收缩）" :
                      isCollapsed ? "展开侧边栏" : "收起侧边栏"
                }
              >
                <div className="flex-shrink-0">
                  <img
                    src={logoImg}
                    alt="Docker Copilot"
                    className="h-9 w-9 sm:h-11 sm:w-11 rounded-xl object-cover shadow-md group-hover:shadow-lg group-hover:scale-110 transition-all duration-200 border-0"
                  />
                </div>
                {!isCollapsed && (
                  <div className="text-left transition-all duration-300 min-w-0 flex-1">
                    <h1 className="text-base sm:text-lg font-bold text-gray-900 dark:text-white">Docker Copilot</h1>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">容器管理平台</p>
                  </div>
                )}
              </button>
            </div>

          {/* 分割线 */}
          <div className="px-4 sm:px-5">
            <div className="h-px bg-gradient-to-r from-transparent via-gray-200 dark:via-gray-700 to-transparent" />
          </div>

          <div className={cn('pt-2', isCollapsed ? 'px-2.5' : 'px-3 sm:px-4')}>
            <DeviceSelector deviceId={deviceId} onChange={onDeviceChange} onManageDevices={onManageDevices} compact={isCollapsed} />
          </div>

          {/* 导航菜单 */}
          <nav aria-label="主导航" className={cn("flex-1 pt-2 pb-4 space-y-2", isCollapsed ? "px-2.5" : "px-3 sm:px-4")}>
            <ul className="space-y-0.5">
              {navItems.map((item) => {
                const Icon = item.icon
                const isActive = activeTab === item.id
                return (
                  <li key={item.id}>
                    <button
                      aria-label={item.label}
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => onTabChange(item.id)}
                      className={cn(
                        "w-full flex items-center rounded-lg text-left transition-all duration-200 group active:scale-95 relative overflow-hidden",
                        isCollapsed ? "justify-center p-2.5 sm:p-3" : "space-x-3 px-3 sm:px-4 py-2.5 sm:py-3",
                        isActive
                          ? "bg-gradient-to-r from-primary-50 to-primary-100/50 dark:from-primary-900/30 dark:to-primary-900/10 text-primary-700 dark:text-primary-300 font-semibold shadow-sm"
                          : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
                      )}
                      title={isCollapsed ? item.label : undefined}
                    >
                      {/* 左侧指示条 */}
                      {isActive && !isCollapsed && (
                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary-500 dark:bg-primary-400 rounded-r-full" />
                      )}

                      <Icon className={cn(
                        "flex-shrink-0 transition-all duration-200",
                        isCollapsed ? "h-6 w-6" : "h-5 w-5",
                        isActive && "scale-110"
                      )} />
                      {!isCollapsed && (
                        <span className="truncate text-sm sm:text-base font-medium">{item.label}</span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>

          {/* 桌面辅助操作与版本信息 */}
          <div className={cn("flex flex-col flex-shrink-0", isCollapsed ? "p-2.5" : "p-4 sm:p-5")}>
            {/* 分割线 */}
            <div className="mb-4">
              <div className="h-px bg-gradient-to-r from-transparent via-gray-200 dark:via-gray-700 to-transparent" />
            </div>

            {/* 操作按钮 */}
            <div className={cn(
              "flex items-center gap-2 mb-4",
              isCollapsed ? "flex-col" : "justify-between"
            )}>
              <ThemeToggle collapsed={isCollapsed} />
              <button
                onClick={onLogout}
                className={cn(
                  "flex items-center justify-center gap-2 transition-all duration-200 group active:scale-95",
                  isCollapsed
                    ? "p-2.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg w-full"
                    : "px-3 py-2.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg flex-1"
                )}
                title={isCollapsed ? "退出登录" : ""}
              >
                <LogOut className="h-4 w-4 flex-shrink-0 group-hover:rotate-12 transition-transform duration-300" />
                {!isCollapsed && (
                  <span className="text-xs sm:text-sm font-medium">退出</span>
                )}
              </button>
            </div>

            {/* 版本信息部分 */}
            {isCollapsed ? (
              // 收起状态 - 简约指示
              <div className="space-y-3">
                {/* 状态指示 */}
                <div className="flex justify-center">
                  <span className="w-3 h-3 rounded-full bg-emerald-500 shadow-sm shadow-emerald-400/50 dark:shadow-emerald-600/50" title={`运行中 - ${backendVersion || 'v1.0'}`} />
                </div>

                {/* 更新提示 */}
                {hasBackendUpdate && (
                  <div className="flex justify-center">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" title="有新版本" />
                  </div>
                )}
              </div>
            ) : (
              versionInfo
            )}

            <div className="mt-3">{projectLinks(isCollapsed)}</div>
          </div>
        </div>
      </aside>}



      {/* 版本更新提示弹窗 */}
      <UpdatePrompt
        isVisible={showUpdatePrompt}
        onClose={() => setShowUpdatePrompt(false)}
        backendVersion={backendVersion}
        remoteVersion={remoteVersion}
        hasBackendUpdate={hasBackendUpdate}
        onUpdateBackend={updateBackend}
        isUpdating={isUpdating}
      />
    </>
  )
}

// 手机底部导航栏组件
export function MobileBottomNav({ activeTab, onTabChange, windowWidth = 1024 }) {
  return (
    <>
      {windowWidth < 768 && (
        <nav
          aria-label="手机导航"
          className="mobile-bottom-nav fixed mx-auto max-w-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full z-40 shadow-lg transition-all duration-300"
          style={{ 
            left: 'max(1rem, var(--safe-area-left))',
            right: 'max(1rem, var(--safe-area-right))',
            bottom: 'calc(var(--safe-area-bottom) + 0.5rem)'
          }}
        >
          <div className="h-full flex items-center justify-around px-2 py-2 gap-1">
            {navItems.map((item) => {
              const Icon = item.icon
              const isActive = activeTab === item.id
              return (
                <button
                  key={item.id}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => onTabChange(item.id)}
                  className={cn(
                    "h-12 flex flex-col items-center justify-center gap-0.5 px-1.5 rounded-full transition-all duration-200 active:scale-95 flex-1 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
                    isActive
                      ? "text-primary-600 dark:text-primary-400 bg-primary-100 dark:bg-primary-900/40"
                      : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/50"
                  )}
                  title={item.label}
                >
                  <Icon className="h-5 w-5 flex-shrink-0" />
                  <span className="text-xs font-medium">{item.label}</span>
                </button>
              )
            })}
          </div>
        </nav>
      )}
    </>
  )
}
