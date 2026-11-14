import { useState, useEffect, useRef } from 'react'
import { useDeviceAPI } from './useDevice.jsx'

// 与提交任务时的设备绑定；组件卸载或切换设备后停止轮询。
export function useProgress(taskId, onComplete, onError) {
  const { progressAPI } = useDeviceAPI()
  const [progress, setProgress] = useState(null)
  const [isPolling, setIsPolling] = useState(false)
  const callbacks = useRef({ onComplete, onError })
  callbacks.current = { onComplete, onError }
  useEffect(() => {
    if (!taskId) return
    let cancelled = false
    let timer
    setIsPolling(true)
    const poll = async () => {
      try {
        const data = (await progressAPI.getProgress(taskId)).data.data
        if (cancelled) return
        setProgress(data)
        if (data.isDone) {
          setIsPolling(false)
          if (data.status === 'succeeded') callbacks.current.onComplete?.(data)
          else callbacks.current.onError?.(data)
        } else timer = setTimeout(poll, 2000)
      } catch (error) {
        if (!cancelled) { setIsPolling(false); callbacks.current.onError?.(error) }
      }
    }
    poll()
    return () => { cancelled = true; clearTimeout(timer); setIsPolling(false) }
  }, [taskId, progressAPI])
  return { progress, isPolling }
}
