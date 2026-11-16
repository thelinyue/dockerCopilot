import React, { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { iconAssetOptions } from '../hooks/iconAssets.js'
import { iconFilename } from '../utils/icons.js'

// 自定义图标通过带认证的节点请求加载，不把登录令牌或设备凭据放进图片 URL。
export function DeviceImage({ src, eager = false, ...props }) {
  const { deviceId, managementAPI } = useDeviceAPI()
  const placeholder = useRef(null)
  const [visible, setVisible] = useState(eager)
  const [asset, setAsset] = useState(null)
  const custom = iconFilename(src) !== null
  const query = useQuery({ ...iconAssetOptions(deviceId, managementAPI, src), enabled: custom && visible })
  useEffect(() => {
    if (!custom) return
    if (eager || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    if (visible || !placeholder.current) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '200px' })
    observer.observe(placeholder.current)
    return () => observer.disconnect()
  }, [custom, eager, visible])
  useEffect(() => {
    if (!custom || !query.data) { setAsset(null); return }
    const url = URL.createObjectURL(query.data)
    setAsset({ blob: query.data, url })
    return () => URL.revokeObjectURL(url)
  }, [custom, query.data])
  if (custom && (!asset || asset.blob !== query.data)) return <span ref={placeholder} role="img" aria-label={props.alt} title={query.error?.message} className={`${props.className || ''} inline-flex items-center justify-center bg-gray-100 dark:bg-gray-700 text-gray-400`}>{query.isError ? '?' : ''}</span>
  return <img loading="lazy" {...props} src={custom ? asset.url : src} />
}
