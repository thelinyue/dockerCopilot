import React, { createContext, useContext, useMemo } from 'react'
import { createDeviceAPI } from '../api/client.js'

const DeviceContext = createContext(null)

export function DeviceProvider({ deviceId, children }) {
  const value = useMemo(() => ({ deviceId, ...createDeviceAPI(deviceId) }), [deviceId])
  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>
}

export function useDeviceAPI() {
  const value = useContext(DeviceContext)
  if (!value) throw new Error('设备上下文尚未初始化')
  return value
}
