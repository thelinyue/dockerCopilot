import React, { useEffect, useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, RefreshCw, Save, FolderOpen, Plus, Play, Square, RotateCcw, Download, Upload, Check, Server, ChevronDown, AlertCircle } from 'lucide-react'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { cn } from '../utils/cn.js'
import { useResourceTasks, projectResource } from '../hooks/useResourceTasks.js'
import { Dialog, Notice, PageHeader, UpdateBadge, useConfirmation } from './ManagementUI.jsx'

const actionLabels = { start: '启动', stop: '停止', restart: '重启', pull: '拉取镜像', deploy: '部署', update: '拉取并更新' }
const actionProgressLabels = { start: '启动中', stop: '停止中', restart: '重启中', pull: '拉取中', deploy: '部署中', update: '更新中' }
const actionResultLabels = { succeeded: '已完成', failed: '操作失败', rolled_back: '操作失败，已恢复', rollback_failed: '恢复失败' }
const actionStatusColors = {
  running: 'text-blue-600 dark:text-blue-400',
  succeeded: 'text-green-600 dark:text-green-400',
  failed: 'text-red-600 dark:text-red-400',
  rolled_back: 'text-amber-600 dark:text-amber-400',
  rollback_failed: 'text-red-600 dark:text-red-400',
  unavailable: 'text-amber-600 dark:text-amber-400',
}
const moreActions = [['restart', RotateCcw], ['pull', Download], ['deploy', Upload]]
const cardActionClass = 'flex-1 flex items-center justify-center gap-1 px-1 py-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg transition-all duration-200 shadow-sm hover:shadow active:scale-95 text-xs font-medium whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed'
const cardActionColors = {
  start: 'text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 hover:border-green-200 dark:hover:border-green-800',
  stop: 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:border-red-200 dark:hover:border-red-800',
  restart: 'text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:border-blue-200 dark:hover:border-blue-800',
  update: 'text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:border-purple-200 dark:hover:border-purple-800',
}

function getProjectState(project) {
  const running = project.services.reduce((sum, service) => sum + service.running, 0)
  const total = project.services.reduce((sum, service) => sum + service.total, 0)
  return { running, total, status: project.error ? 'error' : running ? 'running' : 'stopped' }
}

function ComposeActionMenu({ items, disabled, onAction }) {
  const id = useId()
  const root = useRef(null)
  const trigger = useRef(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  useEffect(() => {
    if (!open) return
    root.current.querySelector('[data-compose-actions] button')?.focus()
    const outside = event => { if (!root.current.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <div ref={root} className="relative flex-1 sm:flex-none" onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }} onKeyDown={event => {
    // 先关闭展开的操作，避免 Escape 同时关闭整个编辑窗口。
    if (open && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
  }}>
    <button ref={trigger} type="button" className="btn-secondary w-full gap-2 px-3 sm:px-4 disabled:opacity-50" aria-label="更多操作" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}>更多<ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} /></button>
    {open && <div id={id} role="group" aria-label="更多项目操作" data-compose-actions className="absolute bottom-full right-0 mb-2 z-10 w-40 p-1.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg">
      {items.map(([name, Icon]) => <button key={name} type="button" disabled={disabled} className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm rounded-lg text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50" onClick={() => {
        setOpen(false)
        trigger.current?.focus()
        onAction(name)
      }}><Icon className="h-4 w-4" />{actionLabels[name]}</button>)}
    </div>}
  </div>
}

export function Compose({ onDirty, initialTarget, onOpenContainers, mobileActions, actionsRef, onActionsChange }) {
  const { deviceId, containerAPI, managementAPI } = useDeviceAPI()
  const queryClient = useQueryClient()
  const confirm = useConfirmation()
  const { data, error, isLoading, isFetching, refetch } = useQuery({ queryKey: [deviceId, 'composeProjects'], queryFn: managementAPI.projects })
  const { data: info } = useQuery({ queryKey: [deviceId, 'nodeInfo'], queryFn: managementAPI.info })
  const { data: containers = [], isFetching: fetchingContainers, refetch: refreshContainers } = useQuery({
    queryKey: [deviceId, 'containers'],
    queryFn: async () => (await containerAPI.getContainers()).data.data || [],
    refetchInterval: 10000,
  })
  const updatableContainerIds = new Set(containers.filter(container => container.haveUpdate).map(container => container.id))
  const hasProjectUpdate = item => item.services.some(service => service.containers.some(id => updatableContainerIds.has(id)))
  const projects = data?.projects || []
  const [projectId, setProjectId] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [index, setIndex] = useState(0)
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [validation, setValidation] = useState(null)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  const [services, setServices] = useState([])
  const [importOpen, setImportOpen] = useState(false)
  const [importName, setImportName] = useState('')
  const [importFiles, setImportFiles] = useState('')
  const [importError, setImportError] = useState('')
  const refreshing = isFetching || fetchingContainers
  const openImport = () => { setImportError(''); setImportOpen(true) }
  const refreshProjects = () => { refetch(); refreshContainers() }
  // 页面保留实际回调，底部只接收显示状态，避免刷新后仍调用旧设备或旧状态。
  React.useImperativeHandle(actionsRef, () => ({ import: openImport, refresh: refreshProjects }))
  React.useLayoutEffect(() => {
    onActionsChange?.({ page: '#compose', label: '项目操作', items: [
      { id: 'import', label: '接管项目', icon: Plus },
      { id: 'refresh', label: '刷新', icon: RefreshCw, disabled: busy || refreshing, busy: refreshing },
    ] })
  }, [onActionsChange, busy, refreshing])
  React.useLayoutEffect(() => () => onActionsChange?.(null), [onActionsChange])
  const { getTask, submitOperation, error: taskReadError, refresh: refreshProgress, isFetching: fetchingProgress } = useResourceTasks()
  const requestNumber = useRef(0)
  const openedTarget = useRef(null)
  const editor = useRef(null)
  const dirty = loaded && content !== original.replace(/\r\n/g, '\n')
  const project = projects.find(item => item.id === projectId)
  const task = project ? getTask(projectResource(project)) : null
  const progress = task
  const taskRunning = !!task && !task.isDone
  const mutating = busy || taskRunning
  const progressError = taskRunning && taskReadError
  const taskStatus = progressError ? 'unavailable' : task?.status || 'running'
  const taskMessage = progressError ? '进度暂不可用，请刷新进度' : task?.message || '正在准备操作…'
  const taskLabel = taskRunning ? `${actionProgressLabels[task.action] || '处理中'}${task?.percentage > 0 ? ` ${Math.round(task.percentage)}%` : ''}` : actionResultLabels[task?.status] || '操作结束'
  const targetServices = project?.services.filter(service => !services.length || services.includes(service.name)) || []
  const running = targetServices.some(service => service.running > 0)
  const hasStopped = targetServices.some(service => service.running < service.total)
  const actionDisabled = mutating || !!project?.error || !info?.capabilities.compose
  const projectTask = !!task
  const currentValidation = loaded && validation?.projectId === projectId && validation.index === index && validation.content === content ? validation : null
  const checking = loaded && (!currentValidation || currentValidation.status === 'checking')
  const invalid = currentValidation?.status === 'done' && !currentValidation.valid
  const filters = [
    { id: 'all', label: '总项目', count: projects.length, color: 'text-primary-600 dark:text-primary-400', active: 'bg-primary-50 dark:bg-primary-900/20' },
    { id: 'running', label: '运行中', count: projects.filter(item => getProjectState(item).status === 'running').length, color: 'text-green-600 dark:text-green-400', active: 'bg-green-50 dark:bg-green-900/20' },
    { id: 'stopped', label: '未运行', count: projects.filter(item => getProjectState(item).status === 'stopped').length, color: 'text-red-600 dark:text-red-400', active: 'bg-red-50 dark:bg-red-900/20' },
    { id: 'update', label: '有更新', count: projects.filter(hasProjectUpdate).length, color: 'text-yellow-600 dark:text-yellow-400', active: 'bg-yellow-50 dark:bg-yellow-900/20' },
    { id: 'error', label: '配置异常', count: projects.filter(item => getProjectState(item).status === 'error').length, color: 'text-yellow-600 dark:text-yellow-400', active: 'bg-yellow-50 dark:bg-yellow-900/20' },
  ]
  // 稳定排序只提升有运行服务的项目，同组保留原有顺序，也包含部分运行的项目。
  const visibleProjects = projects.filter(item => filterStatus === 'update' ? hasProjectUpdate(item) : filterStatus === 'all' || getProjectState(item).status === filterStatus)
    .sort((first, second) => Number(second.services.some(service => service.running > 0)) - Number(first.services.some(service => service.running > 0)))
  useEffect(() => {
    if (!initialTarget || !data || isFetching || openedTarget.current === initialTarget) return
    // 等待项目刷新后再定位；旧节点没有工作目录时，不能用同名项目替代容器的实际归属。
    const exact = initialTarget.id && projects.find(item => item.services.some(service => service.containers.includes(initialTarget.id)))
    const candidates = projects.filter(item => item.name === initialTarget.composeProject && (!initialTarget.composeDirectory || item.directory === initialTarget.composeDirectory))
    const target = exact || ((!initialTarget.id || initialTarget.composeDirectory) && candidates.length === 1 ? candidates[0] : null)
    if (!target) { setFailure('未能定位所属项目，请刷新列表并检查项目目录。'); return }
    openedTarget.current = initialTarget
    setFailure('')
    setProjectId(target.id)
    setServices(target.services.some(service => service.name === initialTarget.composeService) ? [initialTarget.composeService] : [])
  }, [initialTarget, data, isFetching])
  useEffect(() => {
    onDirty(dirty)
    const stop = event => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', stop)
    return () => window.removeEventListener('beforeunload', stop)
  }, [dirty, onDirty])
  useEffect(() => {
    const number = ++requestNumber.current
    setLoaded(false)
    setContent('')
    setOriginal('')
    if (!projectId) return
    setFailure('')
    // 文件读取按选择顺序接收，较早的请求不能覆盖当前文件。
    managementAPI.readFile(projectId, index).then(result => {
      if (number === requestNumber.current) {
        setContent(result.content.replace(/\r\n/g, '\n'))
        setOriginal(result.content)
        setLoaded(true)
      }
    }).catch(e => { if (number === requestNumber.current) setFailure(e.message) })
  }, [projectId, index, managementAPI, reload])
  useEffect(() => {
    if (!projectId || !loaded) { setValidation(null); return }
    const controller = new AbortController()
    let active = true
    const location = { projectId, index, content }
    setValidation({ ...location, status: 'checking' })
    // 停止输入后再检查草稿；切换文件、设备或继续编辑时取消旧请求及结果。
    const timer = setTimeout(async () => {
      try {
        const result = await managementAPI.validateFile(projectId, index, content, controller.signal)
        if (active) setValidation({ ...location, ...result, status: 'done' })
      } catch (error) {
        if (!active) return
        const message = error.response?.status === 404 ? '所选设备暂不支持自动检查，请升级该设备的 DockerCopilot。'
          : error.code === 'ECONNABORTED' ? '配置检查超时，请检查设备连接后重新加载文件。'
          : /[\u4e00-\u9fff]/.test(error.message) ? error.message : '配置检查失败，请检查设备连接后重新加载文件。'
        setValidation({ ...location, status: 'unavailable', message })
      }
    }, 650)
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [projectId, index, content, loaded, managementAPI, reload])
  const locateError = () => {
    const element = editor.current
    const line = Math.max(1, Math.min(currentValidation.line, content.split('\n').length))
    const start = content.split('\n').slice(0, line - 1).reduce((offset, text) => offset + text.length + 1, 0)
    const end = content.indexOf('\n', start)
    element.focus({ preventScroll: true })
    element.setSelectionRange(start, end < 0 ? content.length : end)
    element.scrollTop = Math.max(0, (line - 1) * parseFloat(getComputedStyle(element).lineHeight) - element.clientHeight / 2)
  }
  const canLeave = async () => !dirty || await confirm({ title: '放弃修改', message: '当前文件有未保存的修改。', confirmText: '放弃修改' })
  const selectProject = async id => {
    if (id === projectId || !await canLeave()) return
    setProjectId(id)
    setIndex(0)
    setServices([])
    setMessage('')
  }
  const closeProject = async () => {
    if (!await canLeave()) return
    setProjectId('')
    setServices([])
    setMessage('')
    setFailure('')
  }
  const act = async fn => {
    setBusy(true)
    setFailure('')
    setMessage('')
    try { await fn(); await queryClient.invalidateQueries({ queryKey: [deviceId, 'tasks'] }) } catch (e) { setFailure(e.message) } finally { setBusy(false) }
  }
  const action = async (name, target = project, selectedServices = services) => {
    try {
      await submitOperation(projectResource(target), name, () => managementAPI.composeAction(target.id, name, selectedServices))
    } catch {
      // 提交失败已保存在所属对象的任务中，避免编辑窗口再显示相同错误。
    }
  }
  const viewContainers = (target, serviceName = '') => onOpenContainers({
    projectName: target.name, directory: target.directory, serviceName,
    containerIds: target.services.filter(service => !serviceName || service.name === serviceName).flatMap(service => service.containers),
  })
  const save = deploy => act(async () => {
    const text = original.includes('\r\n') ? content.replace(/\n/g, '\r\n') : content
    await managementAPI.saveFile(projectId, index, original, text)
    setOriginal(text)
    setMessage('已保存，尚未部署；后续自动更新也会应用此配置。')
    if (deploy) await action('deploy')
  })
  const requestAction = async (name, target = project, selectedServices = services) => {
    // 卡片显式传入项目和全部服务，避免沿用上一个编辑窗口的服务选择。
    if (target.id === projectId && dirty) { setFailure('请先保存文件'); return }
    if (['deploy', 'update', 'stop', 'restart'].includes(name) && !await confirm({
      title: `${actionLabels[name]}项目`,
      message: `${actionLabels[name]} ${target.name}${selectedServices.length ? ` 的 ${selectedServices.join('、')}` : ' 的全部服务'}？${['deploy', 'update'].includes(name) ? '将应用已保存的配置；所选范围内已停止的服务可能被启动，卷内数据无法回退。' : ''}`,
      confirmText: actionLabels[name],
      danger: name === 'stop',
    })) return
    await action(name, target, selectedServices)
  }
  const importProject = async event => {
    event.preventDefault()
    if (!await canLeave()) return
    setBusy(true)
    setImportError('')
    try {
      const result = await managementAPI.importProject(importName, importFiles.split('\n').map(value => value.trim()).filter(Boolean))
      await refetch()
      setProjectId(result.id)
      setIndex(0)
      setServices([])
      setImportOpen(false)
      setImportFiles('')
      setImportName('')
      setMessage('项目已接管')
    } catch (e) { setImportError(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="max-w-7xl mx-auto text-gray-900 dark:text-gray-100">
      <PageHeader title="项目管理" className="px-2 sm:px-6" meta={info?.composeRoot && <span className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400" title={info.composeRoot} aria-label={`项目根目录：${info.composeRoot}`}>
        <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0" /><span className="truncate font-mono">{info.composeRoot}</span>
      </span>}>
        {!mobileActions && <>
          <button type="button" aria-label="接管项目" title="接管项目" className="btn-secondary page-action" onClick={openImport}><Plus aria-hidden="true" className="h-4 w-4" /><span className="hidden sm:inline">接管项目</span></button>
          <button type="button" aria-label="刷新" title="刷新" className="btn-primary page-action disabled:opacity-50" disabled={busy || refreshing} onClick={refreshProjects}><RefreshCw aria-hidden="true" className={cn('h-4 w-4', refreshing && 'animate-spin')} /><span className="hidden sm:inline">刷新</span></button>
        </>}
      </PageHeader>
      <div className="px-2 sm:px-6 space-y-4">
        {info && !info.capabilities.compose && <Notice type="warning">当前容器缺少项目管理组件，请升级 DockerCopilot 镜像。</Notice>}
        <Notice>{error?.message}</Notice>
        <Notice type="warning">{data?.warning}</Notice>
        {!project && <>
          <Notice onClose={() => setFailure('')}>{failure}</Notice>
          <Notice type="success" onClose={() => setMessage('')}>{message}</Notice>
        </>}
      </div>

      <div className="px-2 sm:px-6 pt-0 pb-3 sm:py-3">
        <div className="grid grid-cols-5 rounded-3xl overflow-hidden shadow-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          {filters.map((filter, filterIndex) => <button key={filter.id} type="button" aria-pressed={filterStatus === filter.id} onClick={() => setFilterStatus(filter.id)} className={cn(
            'px-0.5 py-3 sm:p-5 text-center transition-all duration-300 group flex flex-col items-center justify-center min-w-0',
            filterIndex < filters.length - 1 && 'border-r border-gray-200 dark:border-gray-700',
            filterStatus === filter.id ? filter.active : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
          )}>
            <span className={cn('text-2xl sm:text-3xl font-bold transition-transform duration-300 group-hover:scale-110', filter.color)}>{isLoading || (!data && error) ? '—' : filter.count}</span>
            <span className="text-[10px] sm:text-sm text-gray-600 dark:text-gray-400 mt-1 whitespace-nowrap">{filter.label}</span>
          </button>)}
        </div>
      </div>

      <div className="px-2 sm:px-6 pt-0 pb-4 sm:py-3">
        {filterStatus !== 'all' && <div className="flex justify-end mb-3">
          <button type="button" className="text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline" onClick={() => setFilterStatus('all')}>清除筛选</button>
        </div>}
        {isLoading ? <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4" aria-label="正在加载项目">
          {[1, 2, 3, 4].map(value => <div key={value} className="card rounded-2xl p-4 animate-pulse"><div className="h-16 bg-gray-100 dark:bg-gray-700 rounded-lg" /><div className="h-8 mt-3 bg-gray-100 dark:bg-gray-700 rounded-lg" /></div>)}
        </div> : visibleProjects.length ? <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {visibleProjects.map(item => {
            const { running, total, status } = getProjectState(item)
            const cardActions = running ? [['stop', Square], ['restart', RotateCcw], ['update', Upload]] : [['start', Play], ['update', Upload]]
            const statusLabel = running ? `${running < total ? '部分运行' : '运行中'} ${running}/${total}` : '未运行'
            const cardTask = getTask(projectResource(item))
            const currentTask = !!cardTask
            const showTaskStatus = currentTask && (!cardTask.isDone || cardTask.status === 'succeeded')
            const progress = cardTask
            const taskRunning = !!cardTask && !cardTask.isDone
            const updating = taskRunning
            const progressError = updating && taskReadError
            const taskStatus = progressError ? 'unavailable' : cardTask?.status || 'running'
            const taskMessage = progressError ? '进度暂不可用，请刷新进度' : cardTask?.message
            const taskLabel = updating ? `${actionProgressLabels[cardTask.action] || '处理中'}${cardTask.percentage > 0 ? ` ${Math.round(cardTask.percentage)}%` : ''}` : actionResultLabels[cardTask?.status] || '操作结束'
            const haveUpdate = hasProjectUpdate(item)
            return <article key={item.id} aria-label={`项目 ${item.name}`} className="card group relative overflow-hidden hover:shadow-lg hover:border-primary-300 dark:hover:border-primary-600 rounded-2xl p-4 min-w-0">
              {haveUpdate && <UpdateBadge />}
              <button type="button" aria-label={`编辑项目 ${item.name}`} disabled={busy && projectId === item.id} onClick={() => selectProject(item.id)} className="flex items-center gap-3 w-full min-w-0 text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50">
                <span className="h-12 w-12 bg-gradient-to-r from-blue-500 to-purple-600 rounded-xl flex items-center justify-center shadow-sm flex-shrink-0"><Boxes className="h-6 w-6 text-white" /></span>
                <span className={cn('w-1 h-8 rounded-full flex-shrink-0', status === 'error' || (running && running < total) ? 'bg-yellow-500' : running ? 'bg-green-500' : 'bg-red-500')} />
                <span className="flex-1 min-w-0">
                  <span className="block font-semibold text-base text-gray-900 dark:text-white truncate group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors" title={item.name}>{item.name}</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5" title={item.directory}>{item.directory}</span>
                  <span role={showTaskStatus ? 'status' : undefined} className={cn('flex items-center gap-1 text-xs mt-1 h-5', showTaskStatus ? actionStatusColors[taskStatus] : item.error ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400')} title={showTaskStatus ? taskMessage : item.error}>
                    {updating && !progressError && <RefreshCw className="h-3 w-3 animate-spin flex-shrink-0" />}
                    <span className="truncate">{showTaskStatus ? updating ? taskMessage : taskLabel : item.error ? '配置异常' : `${statusLabel} · ${item.files.length} 个文件`}</span>
                  </span>
                </span>
              </button>
              <div className="card-actions flex gap-1 mt-3 pt-3 border-t border-gray-100 dark:border-gray-700/50">
                {updating ? progressError ? <button type="button" className={cn(cardActionClass, 'text-primary-600 dark:text-primary-400')} disabled={fetchingProgress} onClick={() => refreshProgress()}><RefreshCw className={cn('h-4 w-4', fetchingProgress && 'animate-spin')} />刷新进度</button> : <div className="flex-1 flex items-center justify-center gap-2 px-1 py-1.5 bg-primary-50 dark:bg-primary-900/20 rounded-lg border border-primary-200 dark:border-primary-800 whitespace-nowrap text-xs font-medium text-primary-600 dark:text-primary-400">
                  <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" /><span>{taskLabel}</span>
                </div> : cardActions.map(([name, Icon]) => <button key={name} type="button" title={`${name === 'update' ? '更新' : actionLabels[name]} ${item.name}`} disabled={updating || (busy && projectId === item.id) || !!item.error || !info?.capabilities.compose} className={cn(cardActionClass, cardActionColors[name])} onClick={() => requestAction(name, item, [])}><Icon className="h-4 w-4" /><span>{name === 'update' ? '更新' : actionLabels[name]}</span></button>)}
                <button type="button" aria-label={`查看 ${item.name} 的容器`} title="查看容器" className={cn(cardActionClass, 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700')} onClick={() => viewContainers(item)}><Server className="h-4 w-4" /><span>容器</span></button>
              </div>
              {currentTask && progress?.isDone && progress.status !== 'succeeded' && <p role="alert" className={cn('mt-3 text-xs whitespace-pre-wrap break-words', actionStatusColors[taskStatus])}>{progress.message}</p>}
            </article>
          })}
        </div> : <div className="text-center py-12">
          <Boxes className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">{error && !data ? '项目读取失败' : projects.length ? '没有匹配的项目' : '暂无项目'}</h3>
          {!projects.length && !error && <button type="button" className="btn-primary gap-2 mt-4" onClick={() => { setImportError(''); setImportOpen(true) }}><Plus className="h-4 w-4" />接管项目</button>}
        </div>}
      </div>
      {project && <Dialog title={project.name} className="max-w-5xl" onClose={busy ? undefined : closeProject}>
        <div className="p-4 sm:p-6 space-y-3">
          <Notice onClose={failure ? () => setFailure('') : undefined}>{failure || project.error}</Notice>
          <Notice type="success" onClose={() => setMessage('')}>{message}</Notice>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="text-sm font-medium" htmlFor="compose-file">配置文件</label>
            <div className="flex items-center gap-3">
              {loaded && <span role="status" className={cn('inline-flex items-center gap-1.5 text-xs', checking ? 'text-gray-500 dark:text-gray-400' : currentValidation?.status === 'unavailable' ? 'text-amber-600 dark:text-amber-400' : invalid ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400')}>
                {checking ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : invalid || currentValidation?.status === 'unavailable' ? <AlertCircle className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                {checking ? '检查中…' : currentValidation?.status === 'unavailable' ? '未能检查' : invalid ? '配置有误' : '配置正常'}
              </span>}
              {dirty && <span className="badge-warning">未保存</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <select id="compose-file" aria-label="项目配置文件" className="input min-w-0 text-sm font-mono" value={index} disabled={busy} onChange={async event => { const value = Number(event.target.value); if (value !== index && await canLeave()) { setIndex(value); setMessage('') } }}>
              {project.files.map((file, fileIndex) => <option key={file} value={fileIndex}>{fileIndex + 1}. {file}</option>)}
            </select>
            <button type="button" className="btn-icon-secondary flex-shrink-0 disabled:opacity-50" aria-label="重新加载文件" title="重新加载文件" disabled={busy} onClick={async () => { if (await canLeave()) { setMessage(''); setReload(value => value + 1) } }}><RefreshCw className="h-4 w-4" /></button>
          </div>
          <textarea ref={editor} id="compose-editor" aria-label="项目配置内容" aria-invalid={invalid || undefined} aria-describedby={invalid || currentValidation?.status === 'unavailable' ? 'compose-validation' : undefined} spellCheck={false} wrap="off" readOnly={!loaded || mutating} className={cn('input block text-sm font-mono leading-6 min-h-[320px] sm:min-h-[420px] resize-y overflow-auto', invalid && 'border-red-400 dark:border-red-500 focus:ring-red-500')} value={content} onChange={e => setContent(e.target.value)} onKeyDown={event => {
            if (event.key === 'Tab' && !mutating && loaded) {
              event.preventDefault()
              const element = event.currentTarget
              const start = element.selectionStart
              const end = element.selectionEnd
              setContent(content.slice(0, start) + '  ' + content.slice(end))
              requestAnimationFrame(() => { element.selectionStart = element.selectionEnd = start + 2 })
            }
          }} />
          {(invalid || currentValidation?.status === 'unavailable') && <div id="compose-validation"><Notice type={invalid ? 'error' : 'warning'}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <span className="min-w-0 flex-1">{currentValidation.message}</span>
              {currentValidation.line > 0 && <button type="button" className="text-xs font-medium underline underline-offset-2 whitespace-nowrap" onClick={locateError}>第 {currentValidation.line} 行</button>}
            </div>
          </Notice></div>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary gap-2 disabled:opacity-50" disabled={mutating || !loaded || !dirty || (invalid && !currentValidation.syntaxValid)} onClick={() => save(false)}><Save className="h-4 w-4" />保存</button>
            <button type="button" className="btn-primary disabled:opacity-50" disabled={mutating || !loaded || !!project.error || !info?.capabilities.compose || invalid} onClick={async () => {
              if (await confirm({ title: '保存并部署', message: `部署 ${project.name}${services.length ? ` 的 ${services.join('、')}` : ' 的全部服务'}？将保存并应用当前配置；卷内数据无法回退。`, confirmText: '保存并部署' })) save(true)
            }}>保存并部署</button>
          </div>
        </div>
        <div className="px-4 sm:px-6 py-4 border-t border-gray-200 dark:border-gray-700 space-y-3">
          {projectTask && <div role="status" className={cn('flex items-start gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-700/30 text-xs', actionStatusColors[taskStatus])}>
            {taskRunning && !progressError ? <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" /> : progress?.status === 'succeeded' ? <Check className="h-4 w-4 flex-shrink-0" /> : <AlertCircle className="h-4 w-4 flex-shrink-0" />}
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{taskMessage}</span>
            {progressError ? <button type="button" className="flex-shrink-0 hover:underline disabled:opacity-50" disabled={fetchingProgress} onClick={() => refreshProgress()}>刷新进度</button> : taskRunning && <span className="flex-shrink-0">{taskLabel}</span>}
          </div>}
          <div className="flex flex-wrap items-center gap-3"><h4 className="text-sm font-semibold">服务</h4><span className="text-xs text-gray-500 dark:text-gray-400">{services.length ? `已选 ${services.length} 项` : '全部服务'}</span><button type="button" className="inline-flex items-center gap-1.5 ml-auto text-xs text-primary-600 dark:text-primary-400 hover:underline" onClick={() => viewContainers(project)}><Server className="h-4 w-4" />查看容器</button></div>
          <div role="group" aria-label="服务选择" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {project.services.map(service => {
              const selected = services.includes(service.name)
              const partial = service.running > 0 && service.running < service.total
              return <div key={service.name} className={cn(
                'card flex items-center min-w-0 rounded-2xl focus-within:ring-2 focus-within:ring-primary-500',
                selected ? 'border-primary-500 dark:border-primary-500 bg-primary-50 dark:bg-primary-900/20 shadow-md' : 'hover:border-primary-300 dark:hover:border-primary-600'
              )}>
                <label className={cn('group flex flex-1 items-center gap-3 min-w-0 p-3 cursor-pointer', busy && 'opacity-50 cursor-not-allowed')}>
                  <input type="checkbox" aria-label={`选择服务 ${service.name}`} disabled={busy} className="sr-only" checked={selected} onChange={event => {
                    const checked = event.target.checked
                    setServices(current => checked ? [...current, service.name] : current.filter(name => name !== service.name))
                  }} />
                  <span aria-hidden="true" className={cn('w-1 h-8 rounded-full flex-shrink-0', partial ? 'bg-yellow-500' : service.running ? 'bg-green-500' : 'bg-red-500')} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold truncate group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors" title={service.name}>{service.name}</span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">{partial ? '部分运行' : service.running ? '运行中' : '未运行'} · {service.running}/{service.total}</span>
                  </span>
                  <span aria-hidden="true" className={cn('h-5 w-5 flex-shrink-0 rounded-md border flex items-center justify-center', selected ? 'bg-primary-600 dark:bg-primary-500 border-primary-600 dark:border-primary-500 text-white' : 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600')}>
                    {selected && <Check className="h-3.5 w-3.5" />}
                  </span>
                </label>
                <button type="button" aria-label={`查看 ${service.name} 的容器`} title="查看服务容器" className="btn-icon-secondary flex-shrink-0 mr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500" onClick={() => viewContainers(project, service.name)}><Server className="h-4 w-4" /></button>
              </div>
            })}
            {!project.services.length && <span className="text-sm text-gray-500 dark:text-gray-400">尚未运行</span>}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={cn('btn-secondary flex-1 sm:flex-none gap-2 px-3 sm:px-4 disabled:opacity-50', running ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400')} disabled={actionDisabled} onClick={() => requestAction(running ? 'stop' : 'start')}>{running ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}{running ? '停止' : '启动'}</button>
            <button type="button" className={cn('btn-secondary flex-1 sm:flex-none gap-2 px-3 sm:px-4 disabled:opacity-50', projectTask && taskRunning && task.action === 'update' ? 'text-primary-600 dark:text-primary-400' : 'text-purple-600 dark:text-purple-400')} title="拉取并更新" disabled={actionDisabled} onClick={() => requestAction('update')}><RefreshCw className={cn('h-4 w-4', projectTask && taskRunning && task.action === 'update' && 'animate-spin')} />{projectTask && taskRunning && task.action === 'update' ? '更新中' : '更新'}</button>
            <ComposeActionMenu key={project.id} items={running && hasStopped ? [['start', Play], ...moreActions] : moreActions} disabled={actionDisabled} onAction={requestAction} />
          </div>
        </div>
      </Dialog>}
      {importOpen && <Dialog title="接管已有项目" onClose={busy ? undefined : () => setImportOpen(false)}>
        <form onSubmit={importProject}>
          <div className="p-6 space-y-4">
            <Notice>{importError}</Notice>
            <label className="block text-sm font-medium">项目名称<input data-autofocus aria-label="接管项目名称" className="input mt-2" placeholder="默认目录名" value={importName} disabled={busy} onChange={e => setImportName(e.target.value)} /></label>
            <label className="block text-sm font-medium">配置文件（每行一个，按顺序）<textarea aria-label="已有配置文件路径" required className="input mt-2 font-mono text-sm" rows={4} placeholder={`${info?.composeRoot || '/compose'}/app/compose.yaml`} value={importFiles} disabled={busy} onChange={e => setImportFiles(e.target.value)} /></label>
          </div>
          <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30 flex justify-end gap-3">
            <button type="button" className="btn-secondary disabled:opacity-50" disabled={busy} onClick={() => setImportOpen(false)}>取消</button>
            <button disabled={busy} className="btn-primary disabled:opacity-50">{busy ? '接管中…' : '接管'}</button>
          </div>
        </form>
      </Dialog>}
    </div>
  )
}
