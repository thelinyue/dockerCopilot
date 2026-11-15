import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeviceAPI } from './useDevice.jsx'

export const resourceKey = resource => resource ? `${resource.type}:${resource.name}` : ''
export const projectResource = project => ({ type: 'project', id: project.id, name: project.name })
export const containerResource = container => container.composeProject
  ? { type: 'project', name: container.composeProject }
  : { type: 'container', id: container.id, name: container.name }
const sameResource = (first, second) => first?.type === second?.type && (
  first?.name === second?.name || (first?.type === 'container' && first.id && first.id === second?.id)
)

// 任务缓存绑定设备和实际对象，两页共用；同步请求也先登记，防止连续点击重复提交。
export function useResourceTasks() {
  const { deviceId, managementAPI } = useDeviceAPI()
  const queryClient = useQueryClient()
  const localKey = [deviceId, 'resourceTasks']
  const { data: local = {} } = useQuery({ queryKey: localKey, queryFn: () => ({}), enabled: false, initialData: {}, gcTime: Infinity })
  const query = useQuery({ queryKey: [deviceId, 'tasks'], queryFn: managementAPI.tasks, refetchInterval: 2000, retry: false })
  const [, tick] = useState(0)
  const remoteIds = new Set((query.data || []).map(task => task.taskID))
  const tasks = [...(query.data || []), ...Object.values(local).filter(task => !remoteIds.has(task.taskID))]
  const latest = new Map()
  for (const task of tasks) {
    if (!task.resource) continue
    const key = resourceKey(task.resource)
    const previous = latest.get(key)
    if (!previous || (previous.isDone && !task.isDone) || (previous.isDone === task.isDone && new Date(task.createdAt) > new Date(previous.createdAt))) latest.set(key, task)
  }
  useEffect(() => {
    // 逐个记录完成状态，不能让 A 的计时器或刷新清除 B 的任务。
    const previous = queryClient.getQueryData([deviceId, 'completedResourceTasks']) || new Set()
    const completed = new Set((query.data || []).filter(task => previous.has(task.taskID)).map(task => task.taskID))
    let changed = false
    for (const task of query.data || []) {
      if (task.isDone && !completed.has(task.taskID)) { completed.add(task.taskID); changed = true }
    }
    if (changed || completed.size !== previous.size) {
      queryClient.setQueryData([deviceId, 'completedResourceTasks'], new Set(completed))
      if (changed) for (const key of ['composeProjects', 'containers', 'images']) queryClient.invalidateQueries({ queryKey: [deviceId, key] })
    }
    // 服务端接收后，以服务端任务为准；自动更新移到下一个对象时不会留下旧的忙碌记录。
    if (Object.values(local).some(task => remoteIds.has(task.taskID))) {
      queryClient.setQueryData(localKey, current => Object.fromEntries(Object.entries(current || {}).filter(([, task]) => !remoteIds.has(task.taskID))))
    }
  }, [query.data, deviceId, queryClient, local])
  const expiries = [...latest.values()].filter(task => task.isDone && task.status === 'succeeded').map(task => new Date(task.updatedAt).getTime() + 3000 - Date.now()).filter(value => value > 0)
  const nextExpiry = expiries.length ? Math.min(...expiries) : 0
  useEffect(() => {
    if (!nextExpiry) return
    const timer = setTimeout(() => tick(value => value + 1), nextExpiry + 20)
    return () => clearTimeout(timer)
  }, [nextExpiry])
  const getTask = resource => {
    // 改名期间沿用相同 ID 的进行中任务，替换容器后仍按实际名称关联进度。
    const task = [...latest.values()].find(task => !task.isDone && sameResource(task.resource, resource)) || latest.get(resourceKey(resource))
    return task?.isDone && task.status === 'succeeded' && Date.now() - new Date(task.updatedAt).getTime() >= 3000 ? null : task
  }
  const submitOperation = useCallback(async (resource, action, request) => {
    const key = resourceKey(resource)
    const current = Object.values(queryClient.getQueryData([deviceId, 'resourceTasks']) || {})
    const remote = queryClient.getQueryData([deviceId, 'tasks']) || []
    if ([...current, ...remote].some(task => !task.isDone && sameResource(task.resource, resource))) throw new Error(`${resource.name} 正在执行操作，请等待完成后重试`)
    const now = new Date().toISOString()
    const pending = { taskID: `pending-${key}-${now}`, resource, action, createdAt: now, updatedAt: now, status: 'running', message: '正在提交操作…', submitting: true, isDone: false, percentage: 0 }
    queryClient.setQueryData([deviceId, 'resourceTasks'], old => ({ ...old, [key]: pending }))
    try {
      const result = await request()
      const taskID = result?.taskID || result?.data?.data?.taskID
      queryClient.setQueryData([deviceId, 'resourceTasks'], old => ({ ...old, [key]: taskID
        ? { ...pending, taskID, submitting: false, message: '正在准备操作…' }
        : { ...pending, submitting: false, isDone: true, status: 'succeeded', percentage: 100, message: '操作完成', updatedAt: new Date().toISOString() } }))
      await queryClient.invalidateQueries({ queryKey: [deviceId, 'tasks'] })
      if (!taskID) for (const item of ['containers', 'composeProjects']) queryClient.invalidateQueries({ queryKey: [deviceId, item] })
      return result
    } catch (error) {
      queryClient.setQueryData([deviceId, 'resourceTasks'], old => ({ ...old, [key]: { ...pending, submitting: false, isDone: true, status: 'failed', message: error.message, updatedAt: new Date().toISOString() } }))
      throw error
    }
  }, [deviceId, queryClient])
  return { getTask, submitOperation, error: query.error, refresh: query.refetch, isFetching: query.isFetching }
}
