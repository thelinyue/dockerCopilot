import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isCancelledError, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeviceAPI } from './useDevice.jsx'
import { createAutosave } from '../utils/autosave.js'

export function useSettingsAutosave({ select, encode = value => value, apply, enabled = true, onDirty, beforeLeave, retryAfter }) {
  const { deviceId, managementAPI } = useDeviceAPI()
  const queryClient = useQueryClient()
  const queryKey = [deviceId, 'settings']
  const query = useQuery({ queryKey, queryFn: managementAPI.settings, enabled, select })
  const [refreshFailure, setRefreshFailure] = useState('')
  const options = useRef()
  options.current = { select, encode, apply, onDirty, retryAfter }
  const mounted = useRef(true)
  const [controller] = useState(() => createAutosave({
    initial: query.data?.settings,
    save: async values => {
      const { select, encode, apply } = options.current
      const patch = encode(values)
      if (!Object.keys(patch).length) return select(queryClient.getQueryData(queryKey)).settings
      // 取消较早的读取，避免保存前的响应在稍后覆盖已确认的配置。
      await queryClient.cancelQueries({ queryKey })
      try { await managementAPI.saveSettings(patch) } catch (error) {
        if (error.code === 'ECONNABORTED' || error.code === 'ERR_NETWORK') error.uncertain = true
        if (error.code === 'ECONNABORTED') error.message = '设置保存请求超时，结果尚未确认，请检查网络后重试。'
        throw error
      }
      const publicData = apply(queryClient.getQueryData(queryKey), patch)
      queryClient.setQueryData(queryKey, publicData)
      if (mounted.current) setRefreshFailure('')
      // 写入成功即确认保存；回读独立进行，下一次写入可以取消它，不阻塞连续编辑。
      void queryClient.fetchQuery({ queryKey, queryFn: managementAPI.settings, retry: false, staleTime: 0 }).catch(error => {
        if (mounted.current && !isCancelledError(error)) setRefreshFailure(`设置已保存，但读取最新配置失败：${error.message}。请稍后刷新确认。`)
      })
      return select(publicData).settings
    },
    onSaved: group => options.current.retryAfter?.[group]?.forEach(key => controller.retry(key)),
  }))
  const [state, setState] = useState(() => controller.snapshot())
  useEffect(() => controller.subscribe(next => {
    setState(next)
    options.current.onDirty?.(next.dirty)
  }), [controller])
  useEffect(() => { controller.sync(query.data?.settings) }, [controller, query.data])
  useLayoutEffect(() => {
    if (beforeLeave) beforeLeave.current = controller.flush
    return () => { if (beforeLeave?.current === controller.flush) beforeLeave.current = null }
  }, [beforeLeave, controller])
  useEffect(() => {
    mounted.current = true
    const stop = event => {
      if (!controller.snapshot().dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', stop)
    return () => {
      mounted.current = false
      controller.dispose()
      window.removeEventListener('beforeunload', stop)
    }
  }, [controller])
  const inputProps = group => ({
    onFocus: () => controller.focus(group),
    onBlur: () => { void controller.blur(group) },
    onCompositionStart: () => controller.compose(group, true),
    onCompositionEnd: () => controller.compose(group, false),
    onKeyDown: event => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        void controller.flush(group)
      }
    },
  })
  return { ...query, ...state, refreshFailure, change: controller.change, flush: controller.flush, retry: controller.retry, inputProps }
}
