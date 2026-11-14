import { useEffect, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useDeviceAPI } from './useDevice.jsx'

/**
 * 检查版本是否需要更新
 * @param {string} currentVersion 当前版本
 * @param {string} latestVersion 最新版本
 * @returns {boolean} 是否需要更新
 */
function shouldUpdate(currentVersion, latestVersion) {
  if (currentVersion?.endsWith('-dev')) return false
  if (currentVersion === 'unknown' || latestVersion === 'unknown') {
    return false
  }
  
  const current = parseVersion(currentVersion)
  const latest = parseVersion(latestVersion)
  
  if (current === null || latest === null) {
    return false
  }
  
  // 比较 major.minor.patch
  if (latest.major > current.major) return true
  if (latest.major === current.major && latest.minor > current.minor) return true
  if (latest.major === current.major && latest.minor === current.minor && latest.patch > current.patch) return true
  
  return false
}

/**
 * 解析版本号
 * @param {string} version 版本号字符串 (e.g., "1.0.0")
 * @returns {Object|null} 解析后的版本对象或 null
 */
function parseVersion(version) {
  if (!version || typeof version !== 'string') return null
  
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-.+)?$/)
  if (!match) return null
  
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    raw: version,
  }
}

/**
 * 版本检查 Hook
 * 用于检查后端版本，并提示用户是否有更新
 */
export function useVersionCheck() {
  const { deviceId, versionAPI, progressAPI } = useDeviceAPI()
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)

  // 查询后端版本信息
  const { data: versionData, refetch } = useQuery({
    queryKey: [deviceId, 'version'],
    queryFn: async () => {
      try {
        // 获取本地版本信息
        const localResponse = await versionAPI.getVersion('local')
        
        let backendVersion = 'unknown'
        let buildDate = ''
        
        if (localResponse.data.code === 200 || localResponse.data.code === 0) {
          const localData = localResponse.data.data
          if (localData && typeof localData === 'object') {
            backendVersion = localData.version || 'unknown'
            buildDate = localData.buildDate || ''
          } else if (typeof localData === 'string') {
            backendVersion = localData
          }
        }
        
        // 获取远端版本信息
        let remoteVersion = 'unknown'
        let versionError = ''
        
        try {
          const remoteResponse = await versionAPI.getVersion('remote')
          
          if (remoteResponse.data.code === 200 || remoteResponse.data.code === 0) {
            const remoteData = remoteResponse.data.data
            if (remoteData && typeof remoteData === 'object') {
              remoteVersion = remoteData.remoteVersion || remoteVersion
            } else if (typeof remoteData === 'string') {
              remoteVersion = remoteData
            }
          }
        } catch (error) {
          versionError = error.message
          console.warn('获取远端版本信息失败:', error)
        }
        
        return {
          backendVersion,
          remoteVersion,
          buildDate,
          versionError,
          hasBackendUpdate: shouldUpdate(backendVersion, remoteVersion)
        }
      } catch (error) {
        console.error('获取版本信息失败:', error)
        return {
          backendVersion: 'unknown',
          remoteVersion: 'unknown',
          buildDate: '',
          versionError: error.message,
          hasBackendUpdate: false
        }
      }
    },
    refetchInterval: 60000, // 每分钟自动刷新
    refetchOnWindowFocus: false,
    staleTime: 30000 // 30秒内不重新请求
  })

  // 后端先返回任务，下载、校验和重启在固定设备执行。
  const updateBackend = useCallback(async () => {
    setIsUpdating(true)
    try {
      const response = await versionAPI.updateProgram()
      const id = response.data.data.taskID
      let completed = false
      for (let attempt = 0; attempt < 300; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        const progress = (await progressAPI.getProgress(id)).data.data
        if (!progress.isDone) continue
        if (progress.status !== 'succeeded') throw new Error(progress.message || '程序更新失败')
        completed = true
        break
      }
      if (!completed) throw new Error('等待更新结果超时，请在该设备的任务列表确认结果，避免重复提交。')
      setShowUpdatePrompt(false)
      setTimeout(() => {
        if ((localStorage.getItem('docker_copilot_device') || 'local') !== deviceId) return
        if (deviceId === 'local') window.location.reload()
        else refetch()
      }, 12000)
    } catch (error) {
      alert(error.response?.data?.msg || error.message)
    } finally {
      setIsUpdating(false)
    }
  }, [deviceId, versionAPI, progressAPI, refetch])

  // 手动检查更新
  const checkForUpdates = useCallback(async () => {
    await refetch()
  }, [refetch])

  return {
    // 状态
    showUpdatePrompt,
    isUpdating,
    
    // 版本数据
    backendVersion: versionData?.backendVersion,
    remoteVersion: versionData?.remoteVersion,
    buildDate: versionData?.buildDate,
    versionError: versionData?.versionError,
    hasBackendUpdate: versionData?.hasBackendUpdate,
    
    // 方法
    setShowUpdatePrompt,
    updateBackend,
    checkForUpdates
  }
}
