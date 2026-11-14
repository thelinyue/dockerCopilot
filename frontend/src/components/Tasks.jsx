import React, { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { cn } from '../utils/cn.js'
import { Dialog, Notice } from './ManagementUI.jsx'

const statusNames = { running: '执行中', succeeded: '成功', failed: '失败', rolled_back: '失败，已恢复', rollback_failed: '恢复失败' }
const statusClass = { running: 'badge-info', succeeded: 'badge-success', failed: 'badge-error', rolled_back: 'badge-warning', rollback_failed: 'badge-error' }
const date = value => value && !value.startsWith('0001') ? new Date(value).toLocaleString() : '—'

function TaskStatus({ task }) {
  return <span className={statusClass[task.status] || 'badge-info'}>{statusNames[task.status] || task.status}{!task.isDone && ` ${task.percentage}%`}</span>
}

function TaskDetails({ task }) {
  return <div className="space-y-3">
    {!task.isDone && <div role="progressbar" aria-label="执行进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.percentage} className="h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden"><div className="h-full bg-primary-500 transition-all" style={{ width: `${task.percentage}%` }} /></div>}
    {task.message && <p className="text-sm whitespace-pre-wrap break-words">{task.message}</p>}
    {task.detailMsg && task.detailMsg !== task.message && <pre className="p-3 rounded-lg bg-gray-50 dark:bg-gray-900 text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words">{task.detailMsg}</pre>}
  </div>
}

export function TaskHistoryDialog({ onClose }) {
  const { deviceId, managementAPI } = useDeviceAPI()
  const { data: tasks = [], error, isLoading, isFetching, refetch } = useQuery({ queryKey: [deviceId, 'tasks'], queryFn: managementAPI.tasks, refetchInterval: 3000 })
  return <Dialog title="执行记录" className="max-w-2xl" onClose={onClose}>
    <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3">
      <span className="text-xs text-gray-500 dark:text-gray-400">{tasks.length} 条记录</span>
      <button type="button" className="btn-icon-secondary disabled:opacity-50" disabled={isFetching} onClick={() => refetch()} aria-label="刷新执行记录" title="刷新"><RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} /></button>
    </div>
    {error && <div className="px-4 sm:px-6 pb-3"><Notice>{error.message}</Notice></div>}
    {isLoading ? <div className="h-20 m-4 rounded-lg bg-gray-100 dark:bg-gray-700 animate-pulse" /> : !tasks.length ? (
      <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">暂无执行记录</div>
    ) : <div className="divide-y divide-gray-200 dark:divide-gray-700 border-t border-gray-200 dark:border-gray-700">
      {tasks.map(task => <details key={task.taskID} className="group">
        <summary className="cursor-pointer list-none flex items-center gap-3 px-4 sm:px-6 py-4 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
          <span className="min-w-0 flex-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="max-w-full text-sm font-medium break-words">{task.name}</span>
            <TaskStatus task={task} />
            <span className="w-full sm:w-auto sm:ml-auto text-xs text-gray-500 dark:text-gray-400">{date(task.createdAt)}</span>
          </span>
          <ChevronDown className="h-4 w-4 text-gray-400 flex-shrink-0 group-open:rotate-180 transition-transform" />
        </summary>
        <div className="px-4 sm:px-6 pb-4"><TaskDetails task={task} /></div>
      </details>)}
    </div>}
  </Dialog>
}

// 卡片和弹窗共用轮询；任务始终属于提交时的设备，完成后同步两页状态。
export function useTaskProgress(task) {
  const { deviceId, progressAPI } = useDeviceAPI()
  const queryClient = useQueryClient()
  const completed = useRef(null)
  const query = useQuery({
    queryKey: [deviceId, 'taskProgress', task?.taskID],
    queryFn: async () => (await progressAPI.getProgress(task.taskID)).data.data,
    enabled: !!task?.taskID,
    refetchInterval: query => query.state.data?.isDone ? false : 2000,
    retry: false,
  })
  useEffect(() => {
    if (!query.data?.isDone || completed.current === task?.taskID) return
    completed.current = task.taskID
    for (const key of ['tasks', 'composeProjects', 'containers', 'images']) queryClient.invalidateQueries({ queryKey: [deviceId, key] })
  }, [query.data?.isDone, task?.taskID, deviceId, queryClient])
  return query
}

// 关闭窗口只收起界面，检测与自动更新继续查询结果。
export function TaskProgressDialog({ task, open, onClose }) {
  const { data, error, isFetching, refetch } = useTaskProgress(task)
  if (!open) return null
  return <Dialog title={task.title} onClose={onClose}>
    <div className="p-4 sm:p-6 space-y-4">
      <Notice>{error?.message}</Notice>
      {data ? <>
        <div className="flex flex-wrap items-center justify-between gap-2"><TaskStatus task={data} /><span className="text-xs text-gray-500 dark:text-gray-400">{date(data.createdAt)}</span></div>
        <TaskDetails task={data} />
      </> : !error && <p role="status" className="text-sm text-gray-500 dark:text-gray-400">正在获取执行进度…</p>}
    </div>
    <div className="px-4 sm:px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30 flex justify-end gap-3">
      {error && <button type="button" disabled={isFetching} className="btn-secondary disabled:opacity-50" onClick={() => refetch()}>刷新结果</button>}
      <button type="button" className="btn-primary" onClick={onClose}>{data?.isDone || error ? '关闭' : '后台运行'}</button>
    </div>
  </Dialog>
}
