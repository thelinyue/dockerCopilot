import React, { createContext, useContext, useState } from 'react'

export const WorkspaceContext = createContext(null)
export const useWorkspace = () => useContext(WorkspaceContext)

// 只保留当前会话的浏览位置与筛选；设备之间不共享对象选择或操作状态。
export function useViewState(name, initial) {
  const workspace = useWorkspace()
  const key = `${workspace?.deviceId}:${name}`
  const [value, setValue] = useState(() => workspace?.views.current.has(key) ? workspace.views.current.get(key) : initial)
  const change = next => setValue(previous => {
    const result = typeof next === 'function' ? next(previous) : next
    workspace?.views.current.set(key, result)
    return result
  })
  return [value, change]
}
