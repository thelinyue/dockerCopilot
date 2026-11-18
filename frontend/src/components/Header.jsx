import React from 'react'
import { Box, LogOut, Server, Boxes, Settings, Github, MessageSquare, Play, Square, RotateCcw, Upload, Palette, ChevronRight, ArrowUpRight, RefreshCw, AlertCircle } from 'lucide-react'
import { Dialog } from './ManagementUI.jsx'
import { ThemeToggle } from './ThemeToggle.jsx'
import { UpdatePrompt } from './UpdatePrompt.jsx'
import { cn } from '../utils/cn.js'
import logoImg from '../assets/DockerCopilot-mark.svg'
import { useVersionCheck } from '../hooks/useVersionCheck.js'
import { useWorkspace } from '../hooks/useWorkspace.jsx'

const navItems = [
  { id: '#compose', label: '项目', icon: Boxes },
  { id: '#containers', label: '容器', icon: Server },
  { id: '#images', label: '镜像', icon: Box },
  { id: '#settings', label: '设置', icon: Settings },
]
const batchItems = [
  { id: 'start', label: '启动', icon: Play },
  { id: 'stop', label: '停止', icon: Square },
  { id: 'restart', label: '重启', icon: RotateCcw },
  { id: 'update', label: '更新', icon: Upload },
]

export function ApplicationPreferences({ open, onClose, onLogout }) {
  const workspace = useWorkspace()
  const version = useVersionCheck()
  const [updateOpen, setUpdateOpen] = React.useState(false)
  return <>
    <Dialog title="外观与关于" open={open} onClose={onClose} placement={workspace?.mobile ? 'sheet' : 'center'} className="preferences-panel">
      <div className="preferences-content">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <img src={logoImg} className="h-11 w-11 shrink-0" alt="" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-sm font-semibold">Docker Copilot</span>{version.backendVersion && <span className="rounded-md bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[11px] text-gray-500 dark:text-gray-400">{version.backendVersion === 'unknown' ? '版本未知' : version.backendVersion}</span>}</div>
              <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400" title={workspace?.deviceLabel}>{workspace?.deviceLabel || '本机'}{version.buildDate && <> · <time dateTime={version.buildDate} title={`构建 ${new Date(version.buildDate).toLocaleString('zh-CN')}`}>{new Date(version.buildDate).toLocaleDateString('zh-CN')}</time></>}</p>
            </div>
            {!version.versionError && <button type="button" className="btn-icon-secondary preferences-icon" aria-label="检查更新" title="检查更新" disabled={version.isChecking} onClick={version.checkForUpdates}><RefreshCw aria-hidden="true" className={cn('h-4 w-4', version.isChecking && 'animate-spin motion-reduce:animate-none')} /></button>}
          </div>
          {version.versionError ? <div role="status" className="flex items-center gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"><AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 break-words">{version.versionError}</span><button type="button" className="preferences-retry" disabled={version.isChecking} onClick={version.checkForUpdates}>{version.isChecking ? '检查中' : '重试'}</button></div>
            : version.hasBackendUpdate ? <button type="button" className="preferences-link text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20" onClick={() => setUpdateOpen(true)}><Upload aria-hidden="true" className="h-4 w-4" /><span className="flex-1">发现新版本 {version.remoteVersion}</span><ChevronRight aria-hidden="true" className="h-4 w-4" /></button> : null}
        </div>
        <div className="preferences-section flex items-center justify-between gap-3"><span className="text-sm font-medium shrink-0">外观</span><ThemeToggle mobile={workspace?.mobile} /></div>
        <div className="preferences-section space-y-0.5">
          <a className="preferences-link" href="https://github.com/thelinyue/dockerCopilot" target="_blank" rel="noopener noreferrer"><Github aria-hidden="true" className="h-4 w-4 text-gray-500 dark:text-gray-400" /><span className="flex-1">项目源码</span><ArrowUpRight aria-hidden="true" className="h-4 w-4 text-gray-400" /></a>
          <a className="preferences-link" href="https://github.com/thelinyue/dockerCopilot/issues" target="_blank" rel="noopener noreferrer"><MessageSquare aria-hidden="true" className="h-4 w-4 text-gray-500 dark:text-gray-400" /><span className="flex-1">问题反馈</span><ArrowUpRight aria-hidden="true" className="h-4 w-4 text-gray-400" /></a>
        </div>
        <div className="preferences-section"><button type="button" className="preferences-link preferences-logout" onClick={onLogout}><LogOut aria-hidden="true" className="h-4 w-4" /><span>退出登录</span></button></div>
      </div>
    </Dialog>
    <UpdatePrompt isVisible={updateOpen || version.showUpdatePrompt} onClose={() => { setUpdateOpen(false); version.setShowUpdatePrompt(false) }} backendVersion={version.backendVersion} remoteVersion={version.remoteVersion} hasBackendUpdate={version.hasBackendUpdate} onUpdateBackend={version.updateBackend} isUpdating={version.isUpdating} error={version.updateError} />
  </>
}

export function Sidebar({ activeTab, onTabChange, isCollapsed, onToggleCollapse, windowWidth }) {
  const workspace = useWorkspace()
  if (windowWidth < 768) return null
  return <aside className={cn('fixed inset-y-0 left-0 z-40 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col', isCollapsed ? 'w-20' : 'w-56')}>
    <button type="button" className={cn('sidebar-brand flex items-center h-16 shrink-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500', isCollapsed ? 'justify-center px-0' : 'px-4')} onClick={onToggleCollapse} disabled={windowWidth < 1024} aria-label={isCollapsed ? '展开侧边栏' : '收起侧边栏'}><span className="flex h-11 w-11 shrink-0 items-center justify-center"><img src={logoImg} className="h-8 w-8" alt="" /></span>{!isCollapsed && <span className="font-semibold whitespace-nowrap text-gray-900 dark:text-white">Docker Copilot</span>}</button>
    <nav aria-label="主导航" className="p-3 space-y-1 flex-1">{navItems.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-label={label} aria-current={activeTab === id ? 'page' : undefined} title={isCollapsed ? label : undefined} className={cn('sidebar-item', isCollapsed && 'justify-center px-0', activeTab === id ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700')} onClick={() => onTabChange(id)}><Icon aria-hidden="true" className="h-5 w-5 shrink-0" />{!isCollapsed && label}</button>)}</nav>
    <div className="mx-3 border-t border-gray-100 dark:border-gray-700/70 py-3"><button type="button" className={cn('sidebar-item text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700', isCollapsed && 'justify-center px-0')} onClick={workspace?.openPreferences} aria-label="外观与关于" aria-haspopup="dialog" title={isCollapsed ? '外观与关于' : undefined}><Palette aria-hidden="true" className="h-5 w-5 shrink-0" />{!isCollapsed && <><span className="flex-1 text-left">外观与关于</span><ChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-gray-400" /></>}</button></div>
  </aside>
}

// 选择模式与导航使用同一个容器，数量和高度始终一致。
export function MobileBottomNav({ activeTab, onTabChange, windowWidth, batch, sidebarWidth }) {
  const selecting = !!batch?.active
  if (windowWidth >= 768 && !selecting) return null
  return <nav aria-label={selecting ? '批量操作' : '底部导航'} style={windowWidth >= 768 ? { left: sidebarWidth } : undefined} className={cn('workspace-bottom mobile-bottom-nav', windowWidth >= 768 && 'desktop-batch-bar')}>
    {(selecting ? batchItems : navItems).map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-label={selecting ? `批量${label}` : label} aria-current={!selecting && activeTab === id ? 'page' : undefined} disabled={selecting && (!batch.selectedCount || batch.disabled)} className={cn('workspace-nav-item', !selecting && activeTab === id && 'workspace-nav-active')} onClick={() => selecting ? batch.onAction(id) : onTabChange(id)}><Icon aria-hidden="true" className="h-5 w-5" /><span>{label}</span></button>)}
  </nav>
}
