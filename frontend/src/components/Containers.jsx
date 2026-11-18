import { DeviceImage } from './DeviceImage.jsx'
import React, { useState } from 'react'
import {
  Play,
  Square,
  RotateCcw,
  RefreshCw,
  Upload,
  Clock,
  Calendar,
  Package,
  Boxes,
  X,
  Info, History, Pencil
} from 'lucide-react'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { cn } from '../utils/cn.js'
import { useResourceTasks, containerResource, projectResource } from '../hooks/useResourceTasks.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getImageLogo } from '../config/imageLogos.js'
import icons8Img from '../assets/icons8.png'
import { ActionMenu, ConnectionNotice, Dialog, Notice, PageHeader, ResourceFilters, Toast, useConfirmation } from './ManagementUI.jsx'
import { useIcons } from '../hooks/useIcons.js'
import { ICON_ACCEPT, normalizeImageRepository } from '../utils/icons.js'
import { useViewState, useWorkspace } from '../hooks/useWorkspace.jsx'
import { useBackLayer } from '../hooks/useBackNavigation.jsx'
import { TaskHistoryDialog } from './Tasks.jsx'

const statusNames = { running: '运行中', stopped: '已停止', exited: '已停止', created: '已创建', paused: '已暂停', restarting: '重启中', dead: '异常', removing: '移除中' }

// 格式化运行时间为中文
function formatRunningTime(runningTime) {
  if (!runningTime) return '未知'

  // 如果已经是中文格式，直接返回
  if (runningTime.includes('小时') || runningTime.includes('分钟') || runningTime.includes('秒')) {
    return runningTime
  }

  // 尝试解析英文格式
  // 支持格式: "2h 30m", "2 hours 30 minutes", "30m", "30 minutes", "1 day 2h 30m" 等
  let hours = 0
  let minutes = 0
  let days = 0

  // 提取天数
  const dayMatch = runningTime.match(/(\d+)\s*(?:day|d)/)
  if (dayMatch) {
    days = parseInt(dayMatch[1])
  }

  // 提取小时
  const hourMatch = runningTime.match(/(\d+)\s*(?:hour|h)/)
  if (hourMatch) {
    hours = parseInt(hourMatch[1])
  }

  // 提取分钟
  const minMatch = runningTime.match(/(\d+)\s*(?:minute|min|m)/)
  if (minMatch) {
    minutes = parseInt(minMatch[1])
  }

  // 构建中文输出
  let result = ''
  if (days > 0) {
    result += `${days}天 `
  }
  if (hours > 0) {
    result += `${hours}小时 `
  }
  if (minutes > 0 || (days === 0 && hours === 0)) {
    result += `${minutes}分钟`
  }

  return result.trim()
}

export function Containers({ scope, onClearScope, onOpenCompose, batchRef, onBatchChange }) {
  const { deviceId, containerAPI, progressAPI, managementAPI } = useDeviceAPI()
  const queryClient = useQueryClient()
  const confirm = useConfirmation()
  const { getTask, submitOperation } = useResourceTasks()
  const workspace = useWorkspace()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [selectedContainer, setSelectedContainer] = useState(null)
  // 添加批量操作相关的状态
  const [selectedContainers, setSelectedContainers] = useState([])
  const [isBatchMode, setIsBatchMode] = useState(false)
  const selectionScroll = React.useRef(0)
  const pageRoot = React.useRef(null)
  // 添加操作状态跟踪
  const [localContainerActions, setContainerActions] = useState({}) // 跟踪每个容器的操作状态
  // 添加筛选状态
  const [filterStatus, setFilterStatus] = useViewState('containers:filter', null) // null 表示显示全部

  // 自定义确认弹窗状态
  const [confirmModal, setConfirmModal] = useState({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: null,
    onCancel: null,
    type: 'info' // info, warning, danger
  })



  // 使用React Query获取容器列表
  const { data: containers = [], isLoading, error, isFetching, refetch } = useQuery({
    queryKey: [deviceId, 'containers'],
    queryFn: async () => {
      const response = await containerAPI.getContainers()
      if (response.data.code === 200 || response.data.code === 0) {
        return response.data.data || []
      } else {
        throw new Error(response.data.msg)
      }
    },
    refetchInterval: 10000, // 每10秒自动刷新一次
  })
  const disconnected = !!error || workspace?.online === false
  const containerActions = { ...localContainerActions }
  for (const container of containers) {
    const task = getTask(containerResource(container))
    if (task && !task.isDone) containerActions[container.id] = { action: task.action, loading: true, progress: task.message, percentage: task.percentage }
  }
  const operationResource = id => containerResource(containers.find(container => container.id === id) || { id, name: id })
  // 旧节点没有目录字段时按项目返回的容器 ID 匹配，避免同名项目串入筛选。
  const projectContainers = containers.filter(container => !scope || (
    container.composeProject === scope.projectName &&
    (!scope.directory || (container.composeDirectory ? container.composeDirectory === scope.directory : scope.containerIds?.includes(container.id))) &&
    (!scope.serviceName || container.composeService === scope.serviceName)
  ))
  const visibleContainers = projectContainers.filter(container => {
    if (filterStatus === 'running') return container.status?.toLowerCase() === 'running'
    if (filterStatus === 'stopped') return container.status?.toLowerCase() !== 'running'
    if (filterStatus === 'update') return container.haveUpdate
    return true
  })
  React.useEffect(() => {
    setSelectedContainers([])
  }, [scope, filterStatus])

  React.useEffect(() => {
    setSelectedContainers(current => current.filter(id => visibleContainers.some(container => container.id === id)))
  }, [containers])

  // 获取自定义图标配置
  const iconQuery = useIcons()
  const customIcons = iconQuery.icons

  const handleContainerAction = async (containerId, action) => {
    try {
      // 设置操作状态为加载中
      setContainerActions(prev => ({
        ...prev,
        [containerId]: { action, loading: true }
      }))

      switch (action) {
        case 'start':
          await submitOperation(operationResource(containerId), 'start', () => containerAPI.startContainer(containerId))
          break
        case 'stop':
          await submitOperation(operationResource(containerId), 'stop', () => containerAPI.stopContainer(containerId))
          break
        case 'restart':
          await submitOperation(operationResource(containerId), 'restart', () => containerAPI.restartContainer(containerId))
          break
        default:
          break
      }

      // 立即更新本地状态，提供即时反馈
      queryClient.setQueryData([deviceId, 'containers'], (oldData) => {
        if (!oldData) return oldData

        return oldData.map(container => {
          if (container.id === containerId) {
            let newStatus = container.status
            switch (action) {
              case 'start':
                newStatus = 'running'
                break
              case 'stop':
                newStatus = 'stopped'
                break
              case 'restart':
                newStatus = 'running'
                break
              default:
                break
            }
            return { ...container, status: newStatus }
          }
          return container
        })
      })

      // 清除操作状态
      setContainerActions(prev => {
        const newState = { ...prev }
        delete newState[containerId]
        return newState
      })

      // 延迟刷新以获取最新数据
      await queryClient.invalidateQueries({ queryKey: [deviceId, 'composeProjects'] })
      setTimeout(() => {
        refetch()
      }, 1500)

    } catch (error) {
      console.error('操作失败:', error)
      // 清除操作状态
      setContainerActions(prev => {
        const newState = { ...prev }
        delete newState[containerId]
        return newState
      })

      // 增加超时错误的处理
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        console.error(`操作超时，请稍后手动刷新页面查看操作结果`)
      } else {
        console.error(`操作失败: ${error.response?.data?.msg || error.message}`)
      }
    }
  }

  // 批量操作处理函数
  const handleBatchAction = async (action) => {
    if (batchBusy || !selectedContainers.length || disconnected) return
    const names = containers.filter(item => selectedContainers.includes(item.id)).map(item => item.name)
    if (!await confirm({ title: `批量${{ start: '启动', stop: '停止', restart: '重启', update: '更新' }[action]}`, message: `设备：${workspace?.deviceLabel || deviceId}\n${names.length} 个容器：${names.join('、')}`, confirmText: '继续', danger: action === 'stop' })) return
    if (action === 'update' && containers.some(c => selectedContainers.includes(c.id) && c.composeProject)) {
      const composeContainers = containers.filter(c => selectedContainers.includes(c.id) && c.composeProject)
      const first = composeContainers[0]
      const sameProject = composeContainers.every(c => c.composeProject === first.composeProject && c.composeDirectory === first.composeDirectory)
      setConfirmModal({ isOpen: true, title: '按项目服务更新', message: '选中的容器包含项目服务，请在项目页面更新，或在更新设置页面按排除规则统一执行。', onConfirm: () => { setConfirmModal({ isOpen: false }); onOpenCompose?.(sameProject ? { ...first, composeService: '' } : null) } })
      return
    }
    setBatchBusy(true)
    const failures = []
    for (const containerId of [...selectedContainers]) {
      const container = containers.find(item => item.id === containerId)
      if (!container) continue
      try {
        if (action === 'update') {
          if (container.status?.toLowerCase() !== 'running') throw new Error('容器已停止，请先启动后再更新')
          const response = await submitOperation(containerResource(container), 'update', () => containerAPI.updateContainer(containerId, container.name, container.usingImage))
          const taskID = response.data.data?.taskID
          if (taskID) await pollProgress(containerId, taskID)
        } else {
          const request = { start: containerAPI.startContainer, stop: containerAPI.stopContainer, restart: containerAPI.restartContainer }[action]
          await submitOperation(containerResource(container), action, () => request(containerId))
        }
      } catch (error) {
        // 一项冲突或失败只记录这一项，继续处理其余所选对象。
        failures.push(`${container.name}：${error.message}`)
      }
    }
    for (const key of ['containers', 'composeProjects']) await queryClient.invalidateQueries({ queryKey: [deviceId, key] })
    setBatchBusy(false)
    exitSelection()
    if (failures.length) setConfirmModal({ isOpen: true, title: '部分操作未完成', message: failures.join('\n'), onConfirm: () => setConfirmModal({ isOpen: false }), onCancel: null, type: 'danger' })
  }

  const handleRenameContainer = async (containerId, newName) => {
    try {
      const response = await submitOperation(operationResource(containerId), 'rename', () => containerAPI.renameContainer(containerId, newName))
      if (response.data.code === 200 || response.data.code === 0) {
        await refetch()
        console.log('重命名成功')
      }
    } catch (error) {
      console.error('重命名容器失败:', error)
      console.error(`重命名失败: ${error.response?.data?.msg || error.message}`)
      throw error
    }
  }

  const handleUpdateContainer = async (containerId, existingTaskID = null) => {
    let submitted = false
    try {
      const container = containers.find(c => c.id === containerId)
      if (!container) throw new Error('容器未找到，请刷新列表后重试。')
      if (existingTaskID) {
        // 详情窗口已登记任务，后续进度由两页共用的对象任务轮询接管。
        setSelectedContainer(null)
        return
      }

      setContainerActions(prev => ({
        ...prev,
        [containerId]: { action: 'update', loading: true, progress: '正在准备更新...', percentage: 0 }
      }))

      if (container.composeProject) {
        const { projects } = await managementAPI.projects()
        // 用实际容器 ID 定位服务，避免同名项目或过期标签把更新扩大到其他服务。
        const project = projects.find(item => item.services.some(service => service.containers.includes(containerId)))
        const service = project?.services.find(item => item.containers.includes(containerId))
        if (!project || !service?.name) throw new Error('未能定位所属项目服务，请刷新列表并检查项目目录。')
        if (project.error) throw new Error(project.error)
        if (!await confirm({
          title: '更新项目服务',
          message: `拉取并更新 ${project.name} 的 ${service.name} 服务？该服务的全部副本将一并更新，并应用已保存的配置，可能启动该服务的停止副本；卷内数据无法回退。`,
          confirmText: '更新',
        })) return
        submitted = true
        await submitOperation(projectResource(project), 'update', () => managementAPI.composeAction(project.id, 'update', [service.name]))
      } else {
        if (container.status?.toLowerCase() !== 'running') throw new Error('容器已停止，请先启动后再更新；自动更新会保持其停止状态。')
        submitted = true
        await submitOperation(containerResource(container), 'update', () => containerAPI.updateContainer(containerId, container.name, container.usingImage))
      }
      setSelectedContainer(null)
    } catch (error) {
      console.error('更新容器失败:', error)
      setSelectedContainer(null)
      // 已提交的失败只在对象卡片显示一次，前置条件失败才使用提示窗口。
      if (!submitted) {
        setConfirmModal({
          isOpen: true,
          title: '无法更新',
          message: error.message,
          onConfirm: () => setConfirmModal({ isOpen: false }),
          onCancel: null,
          type: 'danger'
        })
      }
    } finally {
      setContainerActions(prev => { const next = { ...prev }; delete next[containerId]; return next })
    }
  }

  // 任务及轮询固定在提交设备；只有明确的最终状态才能表示成功。
  const pollProgress = async (containerId, taskID) => {
    try {
      for (let attempt = 0; attempt < 900; attempt++) {
        const task = (await progressAPI.getProgress(taskID)).data.data
        if (task.isDone) {
          await refetch()
          await queryClient.invalidateQueries({ queryKey: [deviceId, 'composeProjects'] })
          if (task.status !== 'succeeded') throw new Error(task.message || '更新失败，请查看当前设备任务详情')
          return
        }
        setContainerActions(prev => ({ ...prev, [containerId]: {
          action: 'update', loading: true,
          progress: task.message || '处理中…', percentage: task.percentage || 0
        } }))
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
      throw new Error('等待结果超时，请在原设备任务列表确认，避免重复提交。')
    } finally {
      setContainerActions(prev => { const next = { ...prev }; delete next[containerId]; return next })
    }
  }

  // 容器选择处理函数
  const toggleContainerSelection = (containerId) => {
    if (selectedContainers.includes(containerId)) {
      setSelectedContainers(selectedContainers.filter(id => id !== containerId))
    } else {
      setSelectedContainers([...selectedContainers, containerId])
    }
  }

  // 全选/取消全选
  const toggleSelectAll = () => {
    if (selectedContainers.length === visibleContainers.length) {
      setSelectedContainers([])
    } else {
      setSelectedContainers(visibleContainers.map(container => container.id))
    }
  }

  const enterSelection = () => {
    selectionScroll.current = pageRoot.current?.closest('main')?.scrollTop || 0
    setIsBatchMode(true)
  }
  const exitSelection = () => {
    setIsBatchMode(false)
    setSelectedContainers([])
    requestAnimationFrame(() => { const main = pageRoot.current?.closest('main'); if (main) main.scrollTop = selectionScroll.current })
  }
  useBackLayer(isBatchMode, exitSelection)

  // 容器页持有所选对象和实际操作；底部组件仅使用摘要及当前回调，切设备时引用自动清空。
  React.useImperativeHandle(batchRef, () => ({
    enter: enterSelection,
    exit: exitSelection,
    selectAll: toggleSelectAll,
    action: handleBatchAction,
  }))
  React.useLayoutEffect(() => {
    onBatchChange?.({ active: isBatchMode, selectedCount: selectedContainers.length, totalCount: visibleContainers.length, disabled: batchBusy || disconnected })
  }, [onBatchChange, isLoading, isBatchMode, selectedContainers.length, visibleContainers.length, batchBusy, disconnected])
  React.useLayoutEffect(() => () => onBatchChange?.(null), [onBatchChange])

  // 获取状态指示器颜色
  const getStatusIndicatorColor = (status) => {
    const statusConfig = {
      running: 'bg-green-500',
      stopped: 'bg-red-500',
      restarting: 'bg-yellow-500',
      paused: 'bg-blue-500'
    }

    return statusConfig[status?.toLowerCase()] || 'bg-gray-500'
  }

  // 获取状态颜色（用于小圆点）
  const getStatusColor = (status) => {
    const statusConfig = {
      running: 'bg-green-500',
      stopped: 'bg-red-500',
      restarting: 'bg-yellow-500',
      paused: 'bg-blue-500'
    }

    return statusConfig[status?.toLowerCase()] || 'bg-gray-500'
  }

  return (
    <div ref={pageRoot} className="workspace-page max-w-7xl mx-auto">
      {iconQuery.isError && <div className="pt-4"><Notice>图标读取失败：{iconQuery.error.message} <button type="button" className="underline" onClick={() => iconQuery.refetch()}>重试</button></Notice></div>}
      <style>{`
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes bounceArrow {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
      `}</style>

      {confirmModal.isOpen && <Dialog title={confirmModal.title} onClose={() => { confirmModal.onCancel?.(); setConfirmModal({ isOpen: false }) }}>
        <div className="p-5 text-sm whitespace-pre-wrap break-words">{confirmModal.message}</div>
        <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={() => { confirmModal.onCancel?.(); setConfirmModal({ isOpen: false }) }}>取消</button>
          <button type="button" className="btn-primary" onClick={() => confirmModal.onConfirm?.()}>确认</button>
        </div>
      </Dialog>}
      <PageHeader title="容器" selection={{ active: isBatchMode, selectedCount: selectedContainers.length, totalCount: visibleContainers.length, onExit: exitSelection, onSelectAll: toggleSelectAll }} menu={[
        { label: '刷新', icon: RefreshCw, disabled: isFetching, onClick: () => refetch() },
        { label: '执行记录', icon: History, onClick: () => setHistoryOpen(true) },
      ]}>
        <button type="button" className="page-action action-accent" disabled={isLoading || disconnected} onClick={enterSelection}>选择</button>
      </PageHeader>
      <ConnectionNotice error={error} hasData={containers.length > 0} retry={() => refetch()} busy={isFetching} />
      <ResourceFilters value={filterStatus} onChange={setFilterStatus} items={[
        { id: null, label: '全部', count: projectContainers.length },
        { id: 'running', label: '运行中', count: projectContainers.filter(c => c.status?.toLowerCase() === 'running').length },
        { id: 'stopped', label: '已停止', count: projectContainers.filter(c => c.status?.toLowerCase() !== 'running').length },
        { id: 'update', label: '有更新', count: projectContainers.filter(c => c.haveUpdate).length },
      ]} />
      {historyOpen && <TaskHistoryDialog onClose={() => setHistoryOpen(false)} />}
      {/* 容器列表 */}
      <div className="resource-list pt-0 pb-4 sm:py-3">
        {scope && <div className="mb-3 flex items-center gap-2 text-sm text-primary-700 dark:text-primary-300">
          <button type="button" className="min-h-[44px] flex items-center gap-1.5 min-w-0" onClick={() => onOpenCompose?.({ composeProject: scope.projectName, composeDirectory: scope.directory, composeService: scope.serviceName })}><Boxes className="h-4 w-4 shrink-0" /><span className="truncate">{scope.projectName}{scope.serviceName && ` / ${scope.serviceName}`}</span></button>
          <button type="button" className="btn-icon-secondary ml-auto shrink-0" aria-label="清除项目筛选" onClick={onClearScope}><X className="h-4 w-4" /></button>
        </div>}
        {isLoading && <div className="resource-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" aria-label="正在加载容器">{[1,2,3].map(id => <div key={id} className="card h-36 animate-pulse" />)}</div>}
        {visibleContainers.length > 0 ? (
          <div className="resource-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {visibleContainers
              .map((container) => {
                const isSelected = selectedContainers.includes(container.id)
                const objectTask = getTask(containerResource(container))
                return (
                  <article key={container.id} aria-label={`容器 ${container.name}`} className={cn('resource-card resource-card-with-actions card p-4 min-w-0', isSelected && 'border-primary-500 dark:border-primary-500 bg-primary-50 dark:bg-primary-900/20')}>
                    <div className="flex items-center gap-3">
                      {isBatchMode && <label className="min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0 cursor-pointer"><input type="checkbox" className="h-5 w-5" aria-label={`选择容器 ${container.name}`} checked={isSelected} onChange={() => toggleContainerSelection(container.id)} /></label>}
                      <button type="button" className="flex flex-1 items-center gap-3 min-w-0 text-left min-h-[64px] rounded-lg focus-visible:ring-2 focus-visible:ring-primary-500" aria-label={isBatchMode ? `选择 ${container.name}` : `查看容器 ${container.name}`} onClick={() => isBatchMode ? toggleContainerSelection(container.id) : setSelectedContainer(container)}>
                        <span className="h-10 w-10 shrink-0 rounded-xl bg-primary-50 dark:bg-primary-900/30 flex items-center justify-center text-primary-600"><DeviceImage src={getImageLogo(container.usingImage, customIcons)} alt="" className="h-10 w-10 rounded-xl object-cover" fallback={<Package className="h-5 w-5" />} /></span>
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-2"><span className="font-semibold truncate">{container.name}</span>{container.haveUpdate && <span className="shrink-0 text-[10px] text-amber-600">有更新</span>}</span>
                          <span className="block text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5" title={container.usingImage}>{container.usingImage}</span>
                          <span className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mt-1"><span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', getStatusIndicatorColor(container.status))} /><span className="truncate">{container.status === 'running' ? `运行中 · ${formatRunningTime(container.runningTime)}` : statusNames[container.status?.toLowerCase()] || '状态未知'}{container.composeProject && ` · ${container.composeProject}`}</span></span>
                        </span>
                      </button>
                    </div>
                    {container.updateError && <p className="mt-2 text-xs text-amber-600 break-words line-clamp-2" title={container.updateError}>无法确认更新：{container.updateError}</p>}
                    {containerActions[container.id]?.loading ? <div role="status" className="flex items-center gap-2 mt-3 min-h-[44px] text-xs text-primary-600"><RefreshCw className="h-4 w-4 animate-spin" /><span>{containerActions[container.id].progress || '处理中…'}</span></div> : !isBatchMode && <div className="card-actions">
                      <button
                        type="button"
                        className="resource-action"
                        disabled={disconnected}
                        onClick={() => handleContainerAction(container.id, container.status === 'running' ? 'stop' : 'start')}
                      >
                        {container.status === 'running' ? <Square aria-hidden="true" className="h-4 w-4" /> : <Play aria-hidden="true" className="h-4 w-4" />}
                        {container.status === 'running' ? '停止' : '启动'}
                      </button>
                      <button type="button" className="resource-action action-accent" disabled={disconnected} onClick={() => handleUpdateContainer(container.id)}>
                        <Upload aria-hidden="true" className="h-4 w-4" />更新
                      </button>
                      <ActionMenu title={`${container.name} 更多操作`} triggerClassName="resource-action action-icon" items={[
                        { label: '容器详情', icon: Info, onClick: () => setSelectedContainer(container) },
                        { label: '重命名', icon: Pencil, disabled: disconnected, onClick: () => setSelectedContainer(container) },
                        { label: '重启', icon: RotateCcw, disabled: disconnected, onClick: () => handleContainerAction(container.id, 'restart') },
                        container.composeProject && { label: '所属项目', icon: Boxes, onClick: () => onOpenCompose?.(container) },
                      ]} />
                    </div>}
                    {objectTask?.isDone && objectTask.status !== 'succeeded' && <div role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">{objectTask.message}<button type="button" className="underline ml-2 min-h-[44px]" onClick={() => setSelectedContainer(container)}>查看并重试</button></div>}
                  </article>
                )
              })}
          </div>
        ) : (
          <div className="text-center py-12">
            <Package className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">{isLoading ? '正在加载…' : error ? '容器读取失败' : scope || filterStatus ? '没有匹配的容器' : '暂无容器'}</h3>
          </div>
        )}
      </div>

      {/* 容器详情弹窗 */}
      {
        selectedContainer && (
          <ContainerDetailModal
            container={selectedContainer}
            disconnected={disconnected}
            connectionError={error}
            onRetry={() => refetch()}
            onClose={() => setSelectedContainer(null)}
            onRename={handleRenameContainer}
            onUpdate={handleUpdateContainer}
            onAction={handleContainerAction}
            onOpenCompose={() => onOpenCompose?.(selectedContainer)}
          />
        )
      }
    </div >
  )
}

// 容器详情弹窗组件
function ContainerDetailModal({ container, disconnected, connectionError, onRetry, onClose, onRename, onUpdate, onAction, onOpenCompose }) {
  const { getTask, submitOperation } = useResourceTasks()
  const objectTask = getTask(containerResource(container))
  const resourceBusy = !!objectTask && !objectTask.isDone
  const { deviceId, containerAPI } = useDeviceAPI()
  const queryClient = useQueryClient()
  const [name, setName] = useState(container.name)
  const [imageNameAndTag, setImageNameAndTag] = useState(container.usingImage)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isActionProcessing, setIsActionProcessing] = useState(false)
  const [currentAction, setCurrentAction] = useState('')
  const [currentContainer, setCurrentContainer] = useState(container)
  const fileInputRef = React.useRef(null)
  const iconButtonRef = React.useRef(null)
  const [isUploadingIcon, setIsUploadingIcon] = useState(false)
  const [failure, setFailure] = useState('')
  const [iconError, setIconError] = useState('')
  const [iconMessage, setIconMessage] = useState('')
  const confirm = useConfirmation()

  // 获取自定义图标配置
  const iconQuery = useIcons()
  const customIcons = iconQuery.icons

  // 当容器切换时，更新表单字段的值
  React.useEffect(() => {
    setName(container.name)
    setImageNameAndTag(container.usingImage)
    setCurrentContainer(container)
  }, [container])

  // 实时更新容器状态
  React.useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const response = await containerAPI.getContainers();
        if (response.data.code === 0) {
          const containers = response.data.data;
          const updatedContainer = containers.find(c => c.id === container.id);
          if (updatedContainer) {
            setCurrentContainer(updatedContainer);
          }
        }
      } catch (error) {
        console.error('获取容器状态失败:', error);
      }
    }, 3000); // 每3秒获取一次最新状态

    return () => clearInterval(interval);
  }, [container.id]);

  const handleIconUpload = async (event) => {
    const file = event.target.files[0]
    if (!file) return
    setIconError('')
    setIconMessage('')
    setIsUploadingIcon(true)
    try {
      // 图标属于当前实际使用的仓库，不绑定尚未执行的“更换镜像”输入。
      setIconMessage(await iconQuery.upload(file, currentContainer.usingImage))
    } catch (error) {
      setIconError(error.message || '图标上传失败，请重试')
    } finally {
      setIsUploadingIcon(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const restoreIcon = async () => {
    const repository = normalizeImageRepository(currentContainer.usingImage)
    if (!await confirm({ title: '恢复默认图标', message: `设备：${iconQuery.deviceName}\n镜像仓库：${repository}\n删除自定义图标后，该仓库全部标签恢复内置或默认图标。`, confirmText: '恢复默认', danger: true })) return
    setIconError('')
    setIconMessage('')
    setIsUploadingIcon(true)
    try {
      setIconMessage(await iconQuery.remove(repository))
      requestAnimationFrame(() => iconButtonRef.current?.focus())
    }
    catch (error) { setIconError(error.message || '恢复默认图标失败，请重试') }
    finally { setIsUploadingIcon(false) }
  }

  const handleContainerAction = async (action) => {
    try {
      setIsActionProcessing(true);
      setCurrentAction(action);

      // 调用传入的onAction函数执行实际操作
      if (action === 'update') {
        await onUpdate(container.id);
      } else {
        await onAction(container.id, action);
      }

      // 无效化查询以触发重新获取数据
      await queryClient.invalidateQueries({ queryKey: [deviceId, 'containers'] })

      setIsActionProcessing(false);
      setCurrentAction('');
    } catch (error) {
      console.error('操作失败:', error);
      setIsActionProcessing(false);
      setCurrentAction('');
    }
  };

  const handleRename = async () => {
    if (name !== currentContainer.name) {
      try {
        setFailure('')
        setIsRenaming(true)
        console.log(`重命名容器: ${currentContainer.name} -> ${name}`)

        await onRename(container.id, name)

        // 无效化查询以触发重新获取数据
        await queryClient.invalidateQueries({ queryKey: [deviceId, 'containers'] })

        // 更新当前容器状态
        setCurrentContainer({ ...currentContainer, name: name })
        // 同时更新表单中的名称
        setName(name);

        console.log('✅ 容器重命名成功')
        setIsRenaming(false)
      } catch (error) {
        setFailure(error.message || '重命名失败，请重试')
        setIsRenaming(false)
      }
    }
  }

  const handleSave = async () => {
    // 如果镜像tag发生变化，则更新容器
    if (currentContainer.composeProject) { onOpenCompose?.(); return }
    if (imageNameAndTag !== currentContainer.usingImage) {
      try {
        setFailure('')
        setIsUpdating(true)

        console.log(`开始更新容器镜像: ${currentContainer.name}`)
        console.log(`原镜像: ${currentContainer.usingImage}`)
        console.log(`新镜像: ${imageNameAndTag}`)

        // 直接调用API更新容器
        const response = await submitOperation(containerResource(container), 'update', () => containerAPI.updateContainer(
          container.id,
          container.name,
          imageNameAndTag
        ))

        console.log('更新容器响应:', response.data)

        if (response.data.code === 200 || response.data.code === 0) {
          const taskID = response.data.data?.taskID

          if (taskID) {
            // 如果返回了taskID，我们需要触发进度轮询
            console.log('更新任务已创建，taskID:', taskID)

            // 关闭弹窗
            onClose()

            // 触发父组件中的进度轮询
            onUpdate(container.id, taskID)

            console.log('✅ 容器更新任务已启动，请在列表中查看进度')
          } else {
            // 没有taskID，更新完成
            await queryClient.invalidateQueries({ queryKey: [deviceId, 'containers'] })
            setImageNameAndTag(imageNameAndTag) // 更新本地状态
            console.log('✅ 容器镜像更新完成')
          }
        } else {
          throw new Error(response.data.msg || '更新失败')
        }

        setIsUpdating(false)
      } catch (error) {
        setFailure(error.message || '更新失败，请在当前设备任务列表确认后重试')
        // 增加超时错误的处理
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          console.error(`更新操作已提交，但连接超时。请稍后手动刷新页面查看操作结果`)
          // 即使超时也关闭弹窗并触发轮询，因为操作可能仍在进行中
          onClose()
          setFailure('更新请求超时，结果尚未确定，请到当前设备任务列表查看；不会自动重试。')
        }
        setIsUpdating(false)
      }
    }
  }





  // 获取状态指示器颜色
  const getStatusIndicatorColor = (status) => {
    const statusConfig = {
      running: 'bg-green-500',
      stopped: 'bg-red-500',
      restarting: 'bg-yellow-500',
      paused: 'bg-blue-500'
    }

    return statusConfig[status?.toLowerCase()] || 'bg-gray-500'
  }

  const getContainerIcon = () => {
    const iconUrl = getImageLogo(currentContainer.usingImage, customIcons)
    return <button ref={iconButtonRef} type="button" className="relative group flex-shrink-0 h-12 w-12 rounded-xl" disabled={disconnected || isUploadingIcon} onClick={() => fileInputRef.current?.click()} aria-label="上传自定义图标" title="点击上传自定义图标">
      {iconUrl ? <DeviceImage src={iconUrl} alt={currentContainer.name} eager className="h-12 w-12 rounded-xl object-contain" />
        : <span className="h-12 w-12 rounded-xl bg-primary-500 text-white inline-flex items-center justify-center"><Package className="h-6 w-6" /></span>}
      <span className={cn('absolute inset-0 bg-black/50 rounded-xl flex items-center justify-center text-white transition-opacity', isUploadingIcon ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')}>
        {isUploadingIcon ? <RefreshCw className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
      </span>
    </button>
  }

  return (
    <Dialog mobileFullScreen title="容器详情" className="max-w-md" onClose={onClose}>
      <div className="px-4"><ConnectionNotice error={connectionError} hasData retry={onRetry} /><Notice onClose={() => setFailure('')}>{failure}</Notice></div>
      {currentContainer.updateError && <div className="px-4 pt-3"><Notice type="warning">无法确认更新：{currentContainer.updateError}</Notice></div>}
        <input type="file" ref={fileInputRef} onChange={handleIconUpload} className="hidden" accept={ICON_ACCEPT} aria-label="容器图标文件" />
        {(iconError || iconMessage || iconQuery.isError) && <div className="px-6 pt-4 space-y-2">
          <Notice onClose={() => setIconError('')}>{iconError}</Notice>
          {iconMessage.includes('回收失败') ? <Notice type="warning" onClose={() => setIconMessage('')}>{iconMessage}</Notice> : <Toast onClose={() => setIconMessage('')}>{iconMessage}</Toast>}
          {iconQuery.isError && <Notice>图标读取失败：{iconQuery.error.message} <button type="button" className="underline" onClick={() => iconQuery.refetch()}>重试</button></Notice>}
        </div>}
        {/* 弹窗头部 */}
        <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <div className="flex justify-between items-center gap-3">
            <div className="min-w-0">
              <div className="flex items-center">
                {getContainerIcon()}
                {/* 状态指示器竖线 */}
                <div className="flex flex-col items-center justify-center h-full ml-3">
                  <div className={cn(
                    "w-1 h-8 rounded-full",
                    getStatusIndicatorColor(currentContainer.status)
                  )}></div>
                </div>
                <div className="ml-3 min-w-0">
                  <span className="block truncate text-sm font-medium text-gray-900 dark:text-white" title={currentContainer.name}>
                    {currentContainer.name}
                  </span>
                  <div className="flex items-center mt-1">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {currentContainer.id.substring(0, 12)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            {Object.keys(customIcons).some(key => normalizeImageRepository(key) === normalizeImageRepository(currentContainer.usingImage)) && <button type="button" onClick={restoreIcon} disabled={disconnected || isUploadingIcon} aria-label="恢复默认图标" title="恢复默认图标" className="btn-icon-secondary flex-shrink-0 disabled:opacity-50"><RotateCcw className="h-4 w-4" /></button>}
          </div>
        </div>

        {/* 弹窗内容 */}
        <div className="px-6 py-4 space-y-4">
          {currentContainer.composeProject && <button type="button" onClick={onOpenCompose} className="inline-flex items-center gap-2 max-w-full text-sm text-primary-600 dark:text-primary-400 hover:underline" title="编辑项目">
            <Boxes className="h-4 w-4 flex-shrink-0" /><span className="truncate">{currentContainer.composeProject}{currentContainer.composeService && ` / ${currentContainer.composeService}`}</span>
          </button>}
          {/* 容器名称 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              容器名称
            </label>
            <div className="flex space-x-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={disconnected || resourceBusy || isRenaming || isActionProcessing || isUpdating}
                className="input flex-1"
                placeholder="输入容器名称"
              />
              <button
                onClick={handleRename}
                disabled={disconnected || resourceBusy || isRenaming || (name === currentContainer.name) || isActionProcessing || isUpdating}
                className={`px-3 py-2 text-sm rounded-lg transition-colors ${isRenaming || (name === currentContainer.name)
                  ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-400'
                  : 'bg-primary-600 text-white hover:bg-primary-700 dark:bg-primary-500 dark:hover:bg-primary-600'
                  }`}
              >
                {isRenaming ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
                    重命名中
                  </>
                ) : '重命名'}
              </button>
            </div>
          </div>

          {/* 镜像信息 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              镜像名称和标签
            </label>
            <div className="flex space-x-2">
              <input
                type="text"
                value={imageNameAndTag}
                onChange={(e) => setImageNameAndTag(e.target.value)}
                className="input flex-1"
                placeholder="例如: nginx:latest"
                disabled={disconnected || resourceBusy || isActionProcessing || isUpdating}
                readOnly={!!currentContainer.composeProject}
              />
              <button
                onClick={handleSave}
                disabled={disconnected || resourceBusy || isUpdating || (!currentContainer.composeProject && ((imageNameAndTag === currentContainer.usingImage) || !imageNameAndTag.trim()))}
                className={`px-3 py-2 text-sm rounded-lg transition-colors flex items-center ${isUpdating || (!currentContainer.composeProject && ((imageNameAndTag === currentContainer.usingImage) || !imageNameAndTag.trim()))
                  ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-400'
                  : 'bg-primary-600 text-white hover:bg-primary-700 dark:bg-primary-500 dark:hover:bg-primary-600'
                  }`}
              >
                {isUpdating ? (
                  <>
                    <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                    更新中
                  </>
                ) : (
                  currentContainer.composeProject ? '编辑项目' : '更换镜像'
                )}
              </button>
            </div>
            {!currentContainer.composeProject && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              修改镜像后点击"更换镜像"按钮将重新创建容器
            </p>}
          </div>
        </div>

        {/* 弹窗底部操作按钮 */}
        <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4 bg-gray-50 dark:bg-gray-700/30">
          <div className="flex justify-end gap-2">

            <div className="flex gap-2 w-full sm:w-auto">
              <button
                onClick={() => onUpdate(container.id)}
                disabled={disconnected || resourceBusy || isActionProcessing || isUpdating}
                className={`flex-1 sm:flex-none px-2 sm:px-4 py-2 text-sm rounded-lg transition-colors flex items-center justify-center sm:justify-start gap-1 sm:gap-2 ${isActionProcessing && currentAction === 'update'
                  ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-400'
                  : 'bg-purple-600 text-white hover:bg-purple-700 dark:bg-purple-500 dark:hover:bg-purple-600'
                  }`}
                title="更新"
              >
                {isActionProcessing && currentAction === 'update' ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
                    <span>更新中</span>
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4 flex-shrink-0" />
                    <span>更新</span>
                  </>
                )}
              </button>

              {currentContainer.status === 'running' ? (
                <>
                  <button
                    onClick={() => handleContainerAction('stop')}
                    disabled={disconnected || resourceBusy || isActionProcessing || isUpdating}
                    className={`flex-1 sm:flex-none px-2 sm:px-4 py-2 text-sm rounded-lg transition-colors flex items-center justify-center sm:justify-start gap-1 sm:gap-2 ${isActionProcessing && currentAction === 'stop'
                      ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-400'
                      : 'bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600'
                      }`}
                    title="停止"
                  >
                    {isActionProcessing && currentAction === 'stop' ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
                        <span>停止中</span>
                      </>
                    ) : (
                      <>
                        <Square className="h-4 w-4 flex-shrink-0" />
                        <span>停止</span>
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => handleContainerAction('restart')}
                    disabled={disconnected || resourceBusy || isActionProcessing || isUpdating}
                    className={`flex-1 sm:flex-none px-2 sm:px-4 py-2 text-sm rounded-lg transition-colors flex items-center justify-center sm:justify-start gap-1 sm:gap-2 ${isActionProcessing && currentAction === 'restart'
                      ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-400'
                      : 'bg-yellow-500 text-white hover:bg-yellow-600 dark:bg-yellow-500 dark:hover:bg-yellow-600'
                      }`}
                    title="重启"
                  >
                    {isActionProcessing && currentAction === 'restart' ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
                        <span>重启中</span>
                      </>
                    ) : (
                      <>
                        <RotateCcw className="h-4 w-4 flex-shrink-0" />
                        <span>重启</span>
                      </>
                    )}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => handleContainerAction('start')}
                  disabled={disconnected || resourceBusy || isActionProcessing || isUpdating}
                  className={`flex-1 sm:flex-none px-2 sm:px-4 py-2 text-sm rounded-lg transition-colors flex items-center justify-center sm:justify-start gap-1 sm:gap-2 ${isActionProcessing && currentAction === 'start'
                    ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-400'
                    : 'bg-green-600 text-white hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600'
                    }`}
                  title="启动"
                >
                  {isActionProcessing && currentAction === 'start' ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
                      <span>启动中</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 flex-shrink-0" />
                      <span>启动</span>
                    </>
                  )}
                </button>
              )}
            </div>


          </div>
        </div>
    </Dialog>
  )
}
