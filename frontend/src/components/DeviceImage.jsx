import React, { useEffect, useState } from 'react'
import { useDeviceAPI } from '../hooks/useDevice.jsx'

// 自定义图标通过带认证的节点请求加载，不把登录令牌或设备凭据放进图片 URL。
export function DeviceImage({ src, ...props }) {
  const { managementAPI } = useDeviceAPI()
  const [asset, setAsset] = useState(null)
  const custom = typeof src === 'string' && src.startsWith('/src/config/image/')
  useEffect(() => {
    if (!custom) return
    const controller = new AbortController()
    let objectURL
    setAsset(null)
    managementAPI.icon(src.split('/').pop(), controller.signal).then(response => {
      if (controller.signal.aborted) return
      objectURL = URL.createObjectURL(response.data)
      setAsset(objectURL)
    }).catch(error => { if (error.code !== 'ERR_CANCELED') setAsset('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="8" fill="#e5e7eb"/><text x="32" y="40" text-anchor="middle" fill="#6b7280" font-size="24">?</text></svg>')) })
    return () => { controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL) }
  }, [src, custom, managementAPI])
  if (custom && !asset) return <span className={props.className} aria-label={props.alt} />
  return <img {...props} src={custom ? asset : src} />
}
