import { DeviceImage } from './DeviceImage.jsx'
import React, { useState } from 'react'
import {
  Play,
  Square,
  RotateCcw,
  RefreshCw,
  Upload,
  Clock,
  Calendar,
  Package,
  Boxes,
  X,
  Info
} from 'lucide-react'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { cn } from '../utils/cn.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getImageLogo } from '../config/imageLogos.js'
import icons8Img from '../assets/icons8.png'
import { Dialog, UpdateBadge, useConfirmation } from './ManagementUI.jsx'

// 格式化运行时间为中文
function formatRunningTime(runningTime) {
  if (!runningTime) return '未知'

  // 如果已经是中文格式，直接返回
  if (runningTime.includes('小时') || runningTime.includes('分钟') || runningTime.includes('秒')) {
    return runningTime
  }

  // 尝试解析英文格式
  // 支持格式: "2h 30m", "2 hours 30 minutes", "30m", "30 minutes", "1 day 2h 30m" 等
  let hours = 0
  let minutes = 0
  let days = 0

  // 提取天数
  const dayMatch = runningTime.match(/(\d+)\s*(?:day|d)/)
  if (dayMatch) {
    days = parseInt(dayMatch[1])
  }

  // 提取小时
  const hourMatch = runningTime.match(/(\d+)\s*(?:hour|h)/)
  if (hourMatch) {
    hours = parseInt(hourMatch[1])
  }

  // 提取分钟
  const minMatch = runningTime.match(/(\d+)\s*(?:minute|min|m)/)
  if (minMatch) {
    minutes = parseInt(minMatch[1])
  }

  // 构建中文输出
  let result = ''
  if (days > 0) {
    result += `${days}天 `
  }
  if (hours > 0) {
    result += `${hours}小时 `
  }
  if (minutes > 0 || (days === 0 && hours === 0)) {
    result += `${minutes}分钟`
  }

  return result.trim()
}

export function Containers({ scope, onClearScope, onOpenCompose }) {
  const { deviceId, containerAPI, progressAPI, imageAPI, managementAPI } = useDeviceAPI()
  const queryClient = useQueryClient()
  const confirm = useConfirmation()
  const [selectedContainer, setSelectedContainer] = useState(null)
  // 添加批量操作相关的状态
  const [selectedContainers, setSelectedContainers] = useState([])
  const [isBatchMode, setIsBatchMode] = useState(false)
  // 添加操作状态跟踪
  const [containerActions, setContainerActions] = useState({}) // 跟踪每个容器的操作状态
  const [updateTasks, setUpdateTasks] = useState({}) // 跟踪更新任务
  // 添加筛选状态
  const [filterStatus, setFilterStatus] = useState(null) // null 表示显示全部

  // 自定义确认弹窗状态
  const [confirmModal, setConfirmModal] = useState({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: null,
    onCancel: null,
    type: 'info' // info, warning, danger
  })



  // 使用React Query获取容器列表
  const { data: containers = [], isLoading, refetch } = useQuery({
    queryKey: [deviceId, 'containers'],
    queryFn: async () => {
      const response = await containerAPI.getContainers()
      if (response.data.code === 200 || response.data.code === 0) {
        console.log('容器数据:', response.data.data)
        return response.data.data || []
      } else {
        throw new Error(response.data.msg)
      }
    },
    refetchInterval: 10000, // 每10秒自动刷新一次
  })
  // 旧节点没有目录字段时按项目返回的容器 ID 匹配，避免同名项目串入筛选。
  const projectContainers = containers.filter(container => !scope || (
    container.composeProject === scope.projectName &&
    (!scope.directory || (container.composeDirectory ? container.composeDirectory === scope.directory : scope.containerIds?.includes(container.id))) &&
    (!scope.serviceName || container.composeService === scope.serviceName)
  ))
  const visibleContainers = projectContainers.filter(container => {
    if (filterStatus === 'running') return container.status?.toLowerCase() === 'running'
    if (filterStatus === 'stopped') return container.status?.toLowerCase() !== 'running'
    if (filterStatus === 'update') return container.haveUpdate
    return true
  })
  React.useEffect(() => {
    setSelectedContainers([])
  }, [scope, filterStatus])

  // 获取自定义图标配置
  const { data: customIcons = {} } = useQuery({
    queryKey: [deviceId, 'customIcons'],
    queryFn: async () => {
      console.log('[Debug] 开始从服务器获取图标配置...')
      try {
        const response = await imageAPI.getIcons()
        console.log('[Debug] 图标API响应:', response.data)
        if (response.data.code === 200 || response.data.code === 0) {
          const icons = response.data.data || {}
          console.log('[Debug] 获取到的图标数据:', icons)
          // update localStorage
          localStorage.setItem(`docker_copilot_image_logos:${deviceId}`, JSON.stringify(icons))
          return icons
        }
      } catch (err) {
        console.error('[Debug] 获取图标失败:', err)
      }
      return {}
    },
    // 初始数据尝试从localStorage获取，避免闪烁
    initialData: () => {
      const saved = localStorage.getItem(`docker_copilot_image_logos:${deviceId}`)
      if (saved) {
        try {
          const parsed = JSON.parse(saved)
          // 只有当有实际数据时才作为初始数据
          if (Object.keys(parsed).length > 0) {
            return parsed
          }
        } catch (e) {
          console.error('解析本地图标配置失败:', e)
        }
      }
      return undefined
    },
    // 即使有初始数据，也立即在后台刷新
    refetchOnMount: true,
  })

  const handleContainerAction = async (containerId, action) => {
    try {
      // 设置操作状态为加载中
      setContainerActions(prev => ({
        ...prev,
        [containerId]: { action, loading: true }
      }))

      switch (action) {
        case 'start':
          await containerAPI.startContainer(containerId)
          break
        case 'stop':
          await containerAPI.stopContainer(containerId)
          break
        case 'restart':
          await containerAPI.restartContainer(containerId)
          break
        default:
          break
      }

      // 立即更新本地状态，提供即时反馈
      queryClient.setQueryData([deviceId, 'containers'], (oldData) => {
        if (!oldData) return oldData

        return oldData.map(container => {
          if (container.id === containerId) {
            let newStatus = container.status
            switch (action) {
              case 'start':
                newStatus = 'running'
                break
              case 'stop':
                newStatus = 'stopped'
                break
              case 'restart':
                newStatus = 'running'
                break
              default:
                break
            }
            return { ...container, status: newStatus }
          }
          return container
        })
      })

      // 清除操作状态
      setContainerActions(prev => {
        const newState = { ...prev }
        delete newState[containerId]
        return newState
      })

      // 延迟刷新以获取最新数据
      await queryClient.invalidateQueries({ queryKey: [deviceId, 'composeProjects'] })
      setTimeout(() => {
        refetch()
      }, 1500)

    } catch (error) {
      console.error('操作失败:', error)
      // 清除操作状态
      setContainerActions(prev => {
        const newState = { ...prev }
        delete newState[containerId]
        return newState
      })

      // 增加超时错误的处理
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        console.error(`操作超时，请稍后手动刷新页面查看操作结果`)
      } else {
        console.error(`操作失败: ${error.response?.data?.msg || error.message}`)
      }
    }
  }

  // 批量操作处理函数
  const handleBatchAction = async (action) => {
    if (action === 'update' && containers.some(c => selectedContainers.includes(c.id) && c.composeProject)) {
      const composeContainers = containers.filter(c => selectedContainers.includes(c.id) && c.composeProject)
      const first = composeContainers[0]
      const sameProject = composeContainers.every(c => c.composeProject === first.composeProject && c.composeDirectory === first.composeDirectory)
      setConfirmModal({ isOpen: true, title: '按项目服务更新', message: '选中的容器包含项目服务，请在项目页面更新，或在自动更新页面按排除规则统一执行。', onConfirm: () => { setConfirmModal({ isOpen: false }); onOpenCompose?.(sameProject ? { ...first, composeService: '' } : null) } })
      return
    }
    try {
      // 为所有选中的容器设置加载状态
      selectedContainers.forEach(containerId => {
        setContainerActions(prev => ({
          ...prev,
          [containerId]: { action, loading: true }
        }))
      })

      // 立即更新本地状态提供即时反馈
      if (action === 'start' || action === 'stop' || action === 'restart') {
        queryClient.setQueryData([deviceId, 'containers'], (oldData) => {
          if (!oldData) return oldData

          return oldData.map(container => {
            if (selectedContainers.includes(container.id)) {
              let newStatus = container.status
              switch (action) {
                case 'start':
                  newStatus = 'running'
                  break
                case 'stop':
                  newStatus = 'stopped'
                  break
                case 'restart':
                  newStatus = 'running'
                  break
                default:
                  break
              }
              return { ...container, status: newStatus }
            }
            return container
          })
        })
      }

      // 对每个选中的容器执行操作
      for (const containerId of selectedContainers) {
        try {
          const container = containers.find(c => c.id === containerId)

          switch (action) {
            case 'start':
              await containerAPI.startContainer(containerId)
              break
            case 'stop':
              await containerAPI.stopContainer(containerId)
              break
            case 'restart':
              await containerAPI.restartContainer(containerId)
              break
            case 'update':
              if (container) {
                const response = await containerAPI.updateContainer(
                  containerId,
                  container.name,
                  container.usingImage,
                  true
                )

                if (response.data.code === 200 || response.data.code === 0) {
                  const taskID = response.data.data?.taskID
                  if (taskID) {
                    // 保存任务ID并开始轮询进度
                    setUpdateTasks(prev => ({
                      ...prev,
                      [containerId]: taskID
                    }))
                    // 串行等待上一项完成，避免与节点操作锁冲突。
                    await pollProgress(containerId, taskID)
                  }
                }
              }
              break
            default:
              break
          }
        } finally {
          // 对于非更新操作，立即清除操作状态
          if (action !== 'update') {
            setContainerActions(prev => {
              const newState = { ...prev }
              delete newState[containerId]
              return newState
            })
          }
        }
      }

      // 如果不是更新操作，延迟刷新以获取最新数据
      await queryClient.invalidateQueries({ queryKey: [deviceId, 'composeProjects'] })
      if (action !== 'update') {
        setTimeout(() => {
          refetch()
        }, 1500)
      }

      // 清除选中状态
      setSelectedContainers([])
      setIsBatchMode(false)
    } catch (error) {
      console.error('批量操作失败:', error)
      // 清除所有操作状态
      selectedContainers.forEach(containerId => {
        setContainerActions(prev => {
          const newState = { ...prev }
          delete newState[containerId]
          return newState
        })
      })

      // 使用自定义弹窗显示错误信息
      setConfirmModal({
        isOpen: true,
        title: '操作失败',
        message: '批量操作失败: ' + (error.response?.data?.msg || error.message || '未知错误'),
        onConfirm: () => setConfirmModal({ isOpen: false }),
        onCancel: null,
        type: 'danger'
      });
    }
  }

  const handleRenameContainer = async (containerId, newName) => {
    try {
      const response = await containerAPI.renameContainer(containerId, newName)
      if (response.data.code === 200 || response.data.code === 0) {
        await refetch()
        console.log('重命名成功')
      }
    } catch (error) {
      console.error('重命名容器失败:', error)
      console.error(`重命名失败: ${error.response?.data?.msg || error.message}`)
    }
  }

  const handleUpdateContainer = async (containerId, existingTaskID = null) => {
    try {
      const container = containers.find(c => c.id === containerId)
      if (!container) {
        console.error('容器未找到')
        return
      }

      console.log(`开始更新容器 "${container.name}"，使用镜像: ${container.usingImage}`)

      setContainerActions(prev => ({
        ...prev,
        [containerId]: { action: 'update', loading: true, progress: '正在准备更新...', percentage: 0 }
      }))

      if (existingTaskID) {
        console.log('复用已有更新任务, taskID:', existingTaskID)
        setUpdateTasks(prev => ({
          ...prev,
          [containerId]: existingTaskID
        }))
        await pollProgress(containerId, existingTaskID)
        return
      }

      if (container.composeProject) {
        const { projects } = await managementAPI.projects()
        // 用实际容器 ID 定位服务，避免同名项目或过期标签把更新扩大到其他服务。
        const project = projects.find(item => item.services.some(service => service.containers.includes(containerId)))
        const service = project?.services.find(item => item.containers.includes(containerId))
        if (!project || !service?.name) throw new Error('未能定位所属项目服务，请刷新列表并检查项目目录。')
        if (project.error) throw new Error(project.error)
        if (!await confirm({
          title: '更新项目服务',
          message: `拉取并更新 ${project.name} 的 ${service.name} 服务？该服务的全部副本将一并更新，并应用已保存的配置；卷内数据无法回退。`,
          confirmText: '更新',
        })) {
          setContainerActions(prev => { const next = { ...prev }; delete next[containerId]; return next })
          return
        }
        const { taskID } = await managementAPI.composeAction(project.id, 'update', [service.name])
        setSelectedContainer(null)
        queryClient.setQueryData([deviceId, 'composeAction'], { taskID, projectId: project.id, action: 'update' })
        setUpdateTasks(prev => ({ ...prev, [containerId]: taskID }))
        await queryClient.invalidateQueries({ queryKey: [deviceId, 'tasks'] })
        await pollProgress(containerId, taskID)
        return
      }

      // 注意参数顺序: id, containerName, imageNameAndTag, delOldContainer
      const response = await containerAPI.updateContainer(
        containerId,
        container.name,
        container.usingImage,
        true
      )

      console.log('更新容器响应:', response.data)

      if (response.data.code === 200 || response.data.code === 0) {
        const taskID = response.data.data?.taskID

        if (taskID) {
          console.log('开始轮询进度, taskID:', taskID)
          // 保存任务ID并开始轮询进度
          setUpdateTasks(prev => ({
            ...prev,
            [containerId]: taskID
          }))

          await pollProgress(containerId, taskID)
        } else {
          // 如果没有返回taskID,说明更新可能立即完成
          setContainerActions(prev => {
            const newState = { ...prev }
            delete newState[containerId]
            return newState
          })
          await refetch()

        }
      } else {
        throw new Error(response.data.msg || '更新失败')
      }
    } catch (error) {
      console.error('更新容器失败:', error)
      setSelectedContainer(null)
      setContainerActions(prev => {
        const newState = { ...prev }
        delete newState[containerId]
        return newState
      })

      // 增加超时错误的处理
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        console.error(`更新操作已提交，但连接超时。请稍后手动刷新页面查看操作结果`)
        // 即使超时也触发轮询，因为操作可能仍在进行中
        // 这里我们不知道taskID，所以无法启动轮询，只能提示用户稍后查看
      } else {
        // 针对名称冲突提供特定的解决方案
        let errorMessage = error.response?.data?.msg || error.message;
        if (errorMessage.includes('重命名') || errorMessage.includes('name conflict') || errorMessage.includes('名称冲突')) {
          errorMessage += '\n\n检测到容器名称冲突问题，建议解决方案：\n' +
            '1. 手动删除或重命名冲突的容器\n' +
            '2. 使用不同的容器名称进行更新\n' +
            '3. 先停止并重命名当前容器，再进行更新操作';
        }

        // 使用自定义弹窗显示错误信息
        setConfirmModal({
          isOpen: true,
          title: '更新失败',
          message: errorMessage,
          onConfirm: () => setConfirmModal({ isOpen: false }),
          onCancel: null,
          type: 'danger'
        });
      }
    }
  }

  // 任务及轮询固定在提交设备；只有明确的最终状态才能表示成功。
  const pollProgress = async (containerId, taskID) => {
    try {
      for (let attempt = 0; attempt < 900; attempt++) {
        const task = (await progressAPI.getProgress(taskID)).data.data
        if (task.isDone) {
          await refetch()
          await queryClient.invalidateQueries({ queryKey: [deviceId, 'composeProjects'] })
          if (task.status !== 'succeeded') throw new Error(task.message || '更新失败，请查看当前设备任务详情')
          return
        }
        setContainerActions(prev => ({ ...prev, [containerId]: {
          action: 'update', loading: true,
          progress: task.message || '处理中…', percentage: task.percentage || 0
        } }))
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
      throw new Error('等待结果超时，请在原设备任务列表确认，避免重复提交。')
    } finally {
      setContainerActions(prev => { const next = { ...prev }; delete next[containerId]; return next })
      setUpdateTasks(prev => { const next = { ...prev }; delete next[containerId]; return next })
    }
  }

  // 容器选择处理函数
  const toggleContainerSelection = (containerId) => {
    if (selectedContainers.includes(containerId)) {
      setSelectedContainers(selectedContainers.filter(id => id !== containerId))
    } else {
      setSelectedContainers([...selectedContainers, containerId])
    }
  }

  // 全选/取消全选
  const toggleSelectAll = () => {
    if (selectedContainers.length === visibleContainers.length) {
      setSelectedContainers([])
    } else {
      setSelectedContainers(visibleContainers.map(container => container.id))
    }
  }

  // 获取状态指示器颜色
  const getStatusIndicatorColor = (status) => {
    const statusConfig = {
      running: 'bg-green-500',
      stopped: 'bg-red-500',
      restarting: 'bg-yellow-500',
      paused: 'bg-blue-500'
    }

    return statusConfig[status?.toLowerCase()] || 'bg-gray-500'
  }

  // 获取状态颜色（用于小圆点）
  const getStatusColor = (status) => {
    const statusConfig = {
      running: 'bg-green-500',
      stopped: 'bg-red-500',
      restarting: 'bg-yellow-500',
      paused: 'bg-blue-500'
    }

    return statusConfig[status?.toLowerCase()] || 'bg-gray-500'
  }

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="card p-6">
              <div className="flex items-center justify-between">
                <div className="space-y-2">
                  <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-32"></div>
                  <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-24"></div>
                </div>
                <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-16"></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
      <style>{`
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes bounceArrow {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
      `}</style>

      {/* 自定义确认弹窗 */}
      {confirmModal.isOpen && (
        <div className="modal-viewport bg-black bg-opacity-50 z-[70]">
          <div role="alertdialog" aria-modal="true" aria-label={confirmModal.title} className="modal-panel bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white">
                {confirmModal.title}
              </h3>
              <button
                onClick={() => {
                  if (confirmModal.onCancel) confirmModal.onCancel();
                  setConfirmModal({ isOpen: false });
                }}
                className="text-gray-400 hover:text-gray-500 dark:text-gray-400 dark:hover:text-gray-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="px-6 py-4">
              <p className="text-gray-600 dark:text-gray-400">
                {confirmModal.message}
              </p>
            </div>
            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30 flex justify-end space-x-3">
              <button
                onClick={() => {
                  if (confirmModal.onCancel) confirmModal.onCancel();
                  setConfirmModal({ isOpen: false });
                }}
                className="btn-secondary"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (confirmModal.onConfirm) confirmModal.onConfirm();
                }}
                className={cn(
                  "btn-primary",
                  confirmModal.type === 'danger' && "bg-red-600 hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600"
                )}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 页面标题和操作 */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 space-y-4 sm:space-y-0 pt-4 sm:pt-0">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">容器管理</h2>
        </div>

        {/* 批量操作按钮区域 */}
        {!isBatchMode ? (
          <div className="flex items-center space-x-3">
            <button
              className="btn-secondary"
              onClick={() => setIsBatchMode(true)}
            >
              批量操作
            </button>

            <button
              className="btn-primary"
              onClick={() => refetch()}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              刷新
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 sm:gap-3 w-full sm:w-auto">
            <button
              className="btn-secondary px-3 sm:px-4 py-2"
              onClick={toggleSelectAll}
              title={selectedContainers.length === visibleContainers.length ? '取消全选' : '全选'}
            >
              <span className="hidden sm:inline">
                {selectedContainers.length === visibleContainers.length ? '取消全选' : '全选'}
              </span>
              <span className="sm:hidden text-sm font-semibold">
                {selectedContainers.length}/{visibleContainers.length}
              </span>
            </button>
            <button
              className={`btn-primary flex items-center justify-center px-3 sm:px-4 py-2 gap-1 sm:gap-2 ${selectedContainers.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={selectedContainers.length === 0}
              onClick={() => handleBatchAction('start')}
              title="启动"
            >
              <Play className="h-4 w-4 flex-shrink-0" />
              <span className="hidden sm:inline">启动</span>
            </button>
            <button
              className={`btn-secondary flex items-center justify-center px-3 sm:px-4 py-2 gap-1 sm:gap-2 ${selectedContainers.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={selectedContainers.length === 0}
              onClick={() => handleBatchAction('stop')}
              title="停止"
            >
              <Square className="h-4 w-4 flex-shrink-0" />
              <span className="hidden sm:inline">停止</span>
            </button>
            <button
              className={`btn-secondary flex items-center justify-center px-3 sm:px-4 py-2 gap-1 sm:gap-2 ${selectedContainers.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={selectedContainers.length === 0}
              onClick={() => handleBatchAction('restart')}
              title="重启"
            >
              <RotateCcw className="h-4 w-4 flex-shrink-0" />
              <span className="hidden sm:inline">重启</span>
            </button>
            <button
              className={`btn-secondary flex items-center justify-center px-3 sm:px-4 py-2 gap-1 sm:gap-2 ${selectedContainers.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={selectedContainers.length === 0}
              onClick={() => handleBatchAction('update')}
              title="更新"
            >
              <Upload className="h-4 w-4 flex-shrink-0" />
              <span className="hidden sm:inline">更新</span>
            </button>
            <button
              className="btn-danger px-3 sm:px-4 py-2"
              onClick={() => {
                setSelectedContainers([])
                setIsBatchMode(false)
              }}
            >
              <span className="hidden sm:inline">取消</span>
              <span className="sm:hidden">✕</span>
            </button>
          </div>
        )}
      </div>

      {/* 统计信息 */}
      <div className="px-2 sm:px-6 py-4">
        <div className="grid grid-cols-4 gap-0 rounded-3xl overflow-hidden shadow-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          {/* 总容器数 */}
          <button
            onClick={() => setFilterStatus(null)}
            className={cn(
              "p-3 sm:p-5 text-center transition-all duration-300 relative overflow-hidden group border-r border-gray-200 dark:border-gray-700 flex flex-col items-center justify-center",
              filterStatus === null ? "bg-primary-50 dark:bg-primary-900/20" : "hover:bg-gray-50 dark:hover:bg-gray-700/50"
            )}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-primary-500/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
            <div className="relative">
              <div className="text-2xl sm:text-3xl font-bold text-primary-600 dark:text-primary-400 transition-transform duration-300 group-hover:scale-110">
                {projectContainers.length}
              </div>
              <div className="text-xs sm:text-sm text-gray-600 dark:text-gray-400 mt-1">总容器</div>
            </div>
          </button>

          {/* 运行中 */}
          <button
            onClick={() => setFilterStatus('running')}
            className={cn(
              "p-3 sm:p-5 text-center transition-all duration-300 relative overflow-hidden group border-r border-gray-200 dark:border-gray-700 flex flex-col items-center justify-center",
              filterStatus === 'running' ? "bg-green-50 dark:bg-green-900/20" : "hover:bg-gray-50 dark:hover:bg-gray-700/50"
            )}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-green-500/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
            <div className="relative">
              <div className="text-2xl sm:text-3xl font-bold text-green-600 dark:text-green-400 transition-transform duration-300 group-hover:scale-110">
                {projectContainers.filter(c => c.status === 'running').length}
              </div>
              <div className="text-xs sm:text-sm text-gray-600 dark:text-gray-400 mt-1">运行中</div>
            </div>
          </button>

          {/* 已停止 */}
          <button
            onClick={() => setFilterStatus('stopped')}
            className={cn(
              "p-3 sm:p-5 text-center transition-all duration-300 relative overflow-hidden group border-r border-gray-200 dark:border-gray-700 flex flex-col items-center justify-center",
              filterStatus === 'stopped' ? "bg-red-50 dark:bg-red-900/20" : "hover:bg-gray-50 dark:hover:bg-gray-700/50"
            )}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-red-500/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
            <div className="relative">
              <div className="text-2xl sm:text-3xl font-bold text-red-600 dark:text-red-400 transition-transform duration-300 group-hover:scale-110">
                {projectContainers.filter(c => c.status && c.status.toLowerCase() !== 'running').length}
              </div>
              <div className="text-xs sm:text-sm text-gray-600 dark:text-gray-400 mt-1">已停止</div>
            </div>
          </button>

          {/* 有更新 */}
          <button
            onClick={() => setFilterStatus('update')}
            className={cn(
              "p-3 sm:p-5 text-center transition-all duration-300 relative overflow-hidden group flex flex-col items-center justify-center",
              filterStatus === 'update' ? "bg-yellow-50 dark:bg-yellow-900/20" : "hover:bg-gray-50 dark:hover:bg-gray-700/50"
            )}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-yellow-500/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
            <div className="relative">
              <div className="text-2xl sm:text-3xl font-bold text-yellow-600 dark:text-yellow-400 transition-transform duration-300 group-hover:scale-110">
                {projectContainers.filter(c => c.haveUpdate).length}
              </div>
              <div className="text-xs sm:text-sm text-gray-600 dark:text-gray-400 mt-1">有更新</div>
            </div>
          </button>
        </div>
      </div>

      {/* 容器列表 */}
      <div className="px-2 sm:px-6 py-4">
        {(scope || filterStatus || selectedContainers.length > 0) && (
          <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                {scope && <button type="button" onClick={() => onOpenCompose?.({ composeProject: scope.projectName, composeDirectory: scope.directory, composeService: scope.serviceName })} className="inline-flex items-center gap-1.5 min-w-0 max-w-full text-sm font-medium text-primary-700 dark:text-primary-300 hover:underline" title="打开项目">
                  <Boxes className="h-4 w-4 flex-shrink-0" /><span className="truncate">{scope.projectName}{scope.serviceName && ` / ${scope.serviceName}`}</span>
                </button>}
                <span className="text-sm text-blue-700 dark:text-blue-300">
                  {filterStatus && (
                    <>
                      {filterStatus === 'running' && '运行中容器 '}
                      {filterStatus === 'stopped' && '已停止容器 '}
                      {filterStatus === 'update' && '有更新容器 '}
                    </>
                  )}
                  {!filterStatus && selectedContainers.length > 0 && (
                    <>
                      已选 {selectedContainers.length} 个
                    </>
                  )}
                  {filterStatus && selectedContainers.length > 0 && (
                    <>
                      &nbsp;·&nbsp;已选中 {selectedContainers.length} 个容器
                    </>
                  )}
                </span>
                {(scope || filterStatus) && (
                  <>
                    <button
                      onClick={() => {
                        setFilterStatus(null)
                        onClearScope?.()
                        setSelectedContainers([])
                        setIsBatchMode(false)
                      }}
                      className="px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-100 bg-blue-100 dark:bg-blue-800/50 rounded transition-colors"
                    >
                      清除筛选
                    </button>
                    <button
                      onClick={() => {
                        setSelectedContainers(visibleContainers.map(c => c.id))
                        setIsBatchMode(true)
                      }}
                      className="px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-100 bg-blue-100 dark:bg-blue-800/50 rounded transition-colors"
                    >
                      全选结果
                    </button>
                  </>
                )}
              </div>
              {selectedContainers.length > 0 && !filterStatus && (
                <button
                  onClick={() => setSelectedContainers([])}
                  className="px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-100 bg-blue-100 dark:bg-blue-800/50 rounded transition-colors"
                >
                  取消选择
                </button>
              )}
            </div>
          </div>
        )}

        {visibleContainers.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {visibleContainers
              .map((container) => {
                const isSelected = selectedContainers.includes(container.id)
                return (
                  <div key={container.id} className="group relative">
                    {container.composeProject && <span title={`所属项目：${container.composeProject}${container.composeService ? ` / ${container.composeService}` : ''}`} className="absolute -top-2 left-3 z-30 max-w-[calc(100%-6rem)] inline-flex items-center gap-1 rounded-md border border-primary-200 dark:border-primary-800 bg-primary-50 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-primary-600 dark:text-primary-400 shadow-sm">
                      <Boxes className="h-3 w-3 flex-shrink-0" /><span className="truncate">{container.composeProject}</span>
                    </span>}
                    {/* 容器卡片 - 简化设计，点击调起详情 */}
                    <div
                      onClick={(e) => {
                        // 如果启用批量模式，点击选择；否则打开详情
                        if (e.metaKey || e.ctrlKey || isBatchMode) {
                          e.stopPropagation()
                          toggleContainerSelection(container.id)
                        } else {
                          setSelectedContainer(container)
                        }
                      }}
                      className={cn(
                        "card relative overflow-hidden transition-all duration-200 hover:shadow-lg border rounded-2xl p-4 cursor-pointer active:scale-98",
                        isSelected
                          ? "border-primary-500 bg-primary-50 dark:bg-primary-900/20 shadow-md"
                          : "border-gray-200 dark:border-gray-700 hover:border-primary-300 dark:hover:border-primary-600"
                      )}
                    >
                      {/* 背景进度条 */}
                      {containerActions[container.id]?.loading && containerActions[container.id]?.action === 'update' && (
                        <div className="absolute inset-0 pointer-events-none rounded-2xl overflow-hidden">
                          <div
                            className="absolute top-0 left-0 bottom-0 bg-gradient-to-r from-primary-500/30 via-primary-400/30 to-primary-500/30 transition-all duration-500 ease-out"
                            style={{
                              width: `${containerActions[container.id].percentage || 0}%`
                            }}
                          >
                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shimmer"
                              style={{
                                backgroundSize: '200% 100%',
                                animation: 'shimmer 2s infinite linear'
                              }} />
                          </div>
                        </div>
                      )}

                      {/* NEW (有更新时显示) */}
                      {container.haveUpdate && <UpdateBadge />}

                      <div className="relative z-10 flex items-center gap-3">
                        {/* 图标 */}
                        <div className="flex-shrink-0">
                          {(() => {
                            let iconUrl = container.iconUrl;
                            if (!iconUrl && container.usingImage) {
                              const builtInLogo = getImageLogo(container.usingImage);
                              if (builtInLogo) {
                                iconUrl = builtInLogo;
                              } else {
                                // 如果没有内置logo，则尝试从用户自定义中查找
                                // const imageLogos = JSON.parse(localStorage.getItem(`docker_copilot_image_logos:${deviceId}`) || '{}');
                                // 使用 React Query 获取的数据
                                const imageLogos = customIcons;

                                for (const [imageName, logoUrl] of Object.entries(imageLogos)) {
                                  if (container.usingImage.startsWith(imageName) ||
                                    container.usingImage.includes(`${imageName}:`)) {
                                    iconUrl = logoUrl;
                                    break;
                                  }
                                }
                              }
                            }

                            if (iconUrl) {
                              return (
                                <DeviceImage
                                  src={iconUrl}
                                  alt={container.name}
                                  className="h-12 w-12 rounded-xl object-cover shadow-sm flex-shrink-0"
                                  onError={(e) => {
                                    e.target.style.display = 'none';
                                    e.target.parentElement.innerHTML = `
                                    <div class="h-12 w-12 bg-gradient-to-r from-blue-500 to-purple-600 rounded-xl flex items-center justify-center shadow-sm">
                                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-6 w-6 text-white">
                                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
                                      </svg>
                                    </div>
                                  `;
                                  }}
                                />
                              );
                            } else {
                              return (
                                <div className="h-12 w-12 bg-gradient-to-r from-blue-500 to-purple-600 rounded-xl flex items-center justify-center shadow-sm flex-shrink-0">
                                  <Package className="h-6 w-6 text-white" />
                                </div>
                              );
                            }
                          })()}
                        </div>

                        {/* 状态指示器（放在图标和信息之间） */}
                        <div className="flex-shrink-0 flex items-center">
                          <div className={cn(
                            "w-1 h-8 rounded-full",
                            getStatusIndicatorColor(container.status)
                          )} />
                        </div>

                        {/* 容器信息 */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center">
                                <h3 className="font-semibold text-gray-900 dark:text-white truncate text-base group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors">
                                  {container.name}
                                </h3>
                              </div>
                              <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                                {container.usingImage}
                              </p>
                              {container.updateError && <p className="text-xs text-amber-600 mt-1 truncate" title={container.updateError}>无法确认更新：{container.updateError}</p>}
                              {!container.updateChecked && !container.updateError && <p className="text-xs text-gray-400 mt-1">尚未检测更新</p>}
                            </div>
                          </div>

                          {/* 统一高度的信息行 - 显示运行时间或状态 */}
                          <div className="h-5 mt-1">
                            {containerActions[container.id]?.loading && containerActions[container.id]?.progress ? (
                              <p className="text-xs text-blue-600 dark:text-blue-400 truncate flex items-center gap-1">
                                <RefreshCw className="h-3 w-3 animate-spin flex-shrink-0" />
                                <span>{containerActions[container.id].progress}</span>
                              </p>
                            ) : container.status === 'running' ? (
                              <div className="text-xs text-gray-500 dark:text-gray-400">
                                运行: {formatRunningTime(container.runningTime)}
                              </div>
                            ) : (
                              <div className="text-xs text-gray-500 dark:text-gray-400">
                                状态: 已停止
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* 操作按钮栏 - 底部水平排列 */}
                      {!isBatchMode && (
                        <div className="card-actions flex gap-1 mt-3 pt-3 border-t border-gray-100 dark:border-gray-700/50">
                          {containerActions[container.id]?.loading ? (
                            <div className="flex-1 flex items-center justify-center space-x-2 px-1 py-1.5 bg-primary-50 dark:bg-primary-900/20 rounded-lg border border-primary-200 dark:border-primary-800 whitespace-nowrap">
                              <RefreshCw className="h-4 w-4 animate-spin text-primary-600 dark:text-primary-400" />
                              <span className="text-xs font-medium text-primary-600 dark:text-primary-400">
                                {containerActions[container.id].action === 'start' && '启动中'}
                                {containerActions[container.id].action === 'stop' && '停止中'}
                                {containerActions[container.id].action === 'restart' && '重启中'}
                                {containerActions[container.id].action === 'update' && `更新中${containerActions[container.id].percentage ? ` ${Math.round(containerActions[container.id].percentage)}%` : ''}`}
                              </span>
                            </div>
                          ) : (
                            <>
                              {container.status === 'running' ? (
                                <>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleContainerAction(container.id, 'stop') }}
                                    className="flex-1 flex items-center justify-center gap-1 px-1 py-1.5 text-red-600 dark:text-red-400 bg-white dark:bg-gray-800 hover:bg-red-50 dark:hover:bg-red-900/20 border border-gray-200 dark:border-gray-700 hover:border-red-200 dark:hover:border-red-800 rounded-lg transition-all duration-200 shadow-sm hover:shadow active:scale-95 text-xs font-medium whitespace-nowrap"
                                    title="停止"
                                  >
                                    <Square className="h-4 w-4" />
                                    <span>停止</span>
                                  </button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleContainerAction(container.id, 'restart') }}
                                    className="flex-1 flex items-center justify-center gap-1 px-1 py-1.5 text-blue-600 dark:text-blue-400 bg-white dark:bg-gray-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 border border-gray-200 dark:border-gray-700 hover:border-blue-200 dark:hover:border-blue-800 rounded-lg transition-all duration-200 shadow-sm hover:shadow active:scale-95 text-xs font-medium whitespace-nowrap"
                                    title="重启"
                                  >
                                    <RotateCcw className="h-4 w-4" />
                                    <span>重启</span>
                                  </button>
                                </>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleContainerAction(container.id, 'start') }}
                                  className="flex-1 flex items-center justify-center gap-1 px-1 py-1.5 text-green-600 dark:text-green-400 bg-white dark:bg-gray-800 hover:bg-green-50 dark:hover:bg-green-900/20 border border-gray-200 dark:border-gray-700 hover:border-green-200 dark:hover:border-green-800 rounded-lg transition-all duration-200 shadow-sm hover:shadow active:scale-95 text-xs font-medium whitespace-nowrap"
                                  title="启动"
                                >
                                  <Play className="h-4 w-4" />
                                  <span>启动</span>
                                </button>
                              )}

                              <button
                                onClick={(e) => { e.stopPropagation(); handleUpdateContainer(container.id) }}
                                className={cn(
                                  "flex-1 flex items-center justify-center gap-1 px-1 py-1.5 bg-white dark:bg-gray-800 border rounded-lg transition-all duration-200 shadow-sm hover:shadow active:scale-95 text-xs font-medium whitespace-nowrap",
                                  container.haveUpdate
                                    ? "text-yellow-600 dark:text-yellow-400 border-yellow-400 dark:border-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-900/20"
                                    : "text-purple-600 dark:text-purple-400 border-gray-200 dark:border-gray-700 hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:border-purple-200 dark:hover:border-purple-800"
                                )}
                                title="更新"
                              >
                                <Upload className="h-4 w-4" />
                                <span>更新</span>
                              </button>
                            </>
                          )}
                          {container.composeProject && <button type="button" onClick={event => { event.stopPropagation(); onOpenCompose?.(container) }} aria-label={`打开 ${container.name} 所属项目`} title="打开所属项目" className="flex-1 flex items-center justify-center gap-1 px-1 py-1.5 text-primary-600 dark:text-primary-400 bg-white dark:bg-gray-800 hover:bg-primary-50 dark:hover:bg-primary-900/20 border border-gray-200 dark:border-gray-700 hover:border-primary-200 dark:hover:border-primary-800 rounded-lg transition-all duration-200 shadow-sm hover:shadow active:scale-95 text-xs font-medium whitespace-nowrap"><Boxes className="h-4 w-4" /><span>项目</span></button>}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
          </div>
        ) : (
          <div className="text-center py-12">
            <Package className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">{scope || filterStatus ? '没有匹配的容器' : '暂无容器'}</h3>
          </div>
        )}
      </div>

      {/* 容器详情弹窗 */}
      {
        selectedContainer && (
          <ContainerDetailModal
            container={selectedContainer}
            onClose={() => setSelectedContainer(null)}
            onRename={handleRenameContainer}
            onUpdate={handleUpdateContainer}
            onAction={handleContainerAction}
            onOpenCompose={() => onOpenCompose?.(selectedContainer)}
          />
        )
      }
    </div >
  )
}

// 容器详情弹窗组件
function ContainerDetailModal({ container, onClose, onRename, onUpdate, onAction, onOpenCompose }) {
  const { deviceId, containerAPI, imageAPI } = useDeviceAPI()
  const queryClient = useQueryClient()
  const [name, setName] = useState(container.name)
  const [imageNameAndTag, setImageNameAndTag] = useState(container.usingImage)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isActionProcessing, setIsActionProcessing] = useState(false)
  const [currentAction, setCurrentAction] = useState('')
  const [currentContainer, setCurrentContainer] = useState(container)
  const fileInputRef = React.useRef(null)
  const [isUploadingIcon, setIsUploadingIcon] = useState(false)

  // 获取自定义图标配置
  const { data: customIcons = {} } = useQuery({
    queryKey: [deviceId, 'customIcons'],
    queryFn: async () => {
      const response = await imageAPI.getIcons()
      if (response.data.code === 200 || response.data.code === 0) {
        return response.data.data || {}
      }
      return {}
    },
    initialData: () => JSON.parse(localStorage.getItem(`docker_copilot_image_logos:${deviceId}`) || '{}'),
  })

  // 当容器切换时，更新表单字段的值
  React.useEffect(() => {
    setName(container.name)
    setImageNameAndTag(container.usingImage)
    setCurrentContainer(container)
  }, [container])

  // 实时更新容器状态
  React.useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const response = await containerAPI.getContainers();
        if (response.data.code === 0) {
          const containers = response.data.data;
          const updatedContainer = containers.find(c => c.id === container.id);
          if (updatedContainer) {
            // 检查是否有镜像图标
            const imageLogos = JSON.parse(localStorage.getItem(`docker_copilot_image_logos:${deviceId}`) || '{}');

            // 如果容器没有自定义图标，则查找镜像图标
            if (!updatedContainer.iconUrl) {
              // 使用完整的镜像名称和标签进行匹配
              const imageFullName = updatedContainer.usingImage;

              // 首先尝试精确匹配（包含tag）
              if (imageLogos[imageFullName]) {
                updatedContainer.iconUrl = imageLogos[imageFullName];
              } else {
                // 如果精确匹配失败，尝试镜像名称匹配（不包含tag部分）
                const imageName = updatedContainer.usingImage.split(':')[0];

                // 遍历所有镜像图标，查找匹配的镜像名称
                for (const [imageId, logoUrl] of Object.entries(imageLogos)) {
                  // 检查镜像名称是否匹配（不包含tag部分）
                  const logoImageName = imageId.split(':')[0];
                  if (imageName === logoImageName) {
                    updatedContainer.iconUrl = logoUrl;
                    break;
                  }
                }
              }
            }

            setCurrentContainer(updatedContainer);
          }
        }
      } catch (error) {
        console.error('获取容器状态失败:', error);
      }
    }, 3000); // 每3秒获取一次最新状态

    return () => clearInterval(interval);
  }, [container.id]);

  const handleIconUpload = async (event) => {
    const file = event.target.files[0]
    if (!file) return

    // 限制文件大小 (例如 2MB)
    if (file.size > 2 * 1024 * 1024) {
      setConfirmModal({
        isOpen: true,
        title: '上传失败',
        message: '图标文件大小不能超过 2MB',
        onConfirm: () => setConfirmModal({ isOpen: false }),
        onCancel: null,
        type: 'danger'
      })
      event.target.value = '' // 重置 input
      return
    }

    try {
      setIsUploadingIcon(true)
      // 使用容器当前的镜像名作为 Key
      // 如果有自定义镜像名配置(容器更新时可能改变)，优先使用新的
      const targetImageName = imageNameAndTag || currentContainer.usingImage

      const response = await imageAPI.uploadIcon(file, targetImageName, currentContainer.name)

      if (response.data.code === 200 || response.data.code === 0) {
        // 上传成功，更新 localStorage
        const filename = response.data.data // 后端返回的文件名
        if (filename) {
          const newPath = `/src/config/image/${filename}`
          const imageLogos = JSON.parse(localStorage.getItem(`docker_copilot_image_logos:${deviceId}`) || '{}')

          // 更新映射: 镜像名 -> 新路径
          imageLogos[targetImageName] = newPath
          localStorage.setItem(`docker_copilot_image_logos:${deviceId}`, JSON.stringify(imageLogos))

          // 强制更新当前容器视图
          setCurrentContainer(prev => ({
            ...prev,
            iconUrl: newPath
          }))

          // 触发全局事件以便其他组件（如列表）更新
          window.dispatchEvent(new Event('storage'))

          // 无效化查询以刷新列表和图标
          await queryClient.invalidateQueries({ queryKey: [deviceId, 'containers'] })
          await queryClient.invalidateQueries({ queryKey: [deviceId, 'customIcons'] })

          console.log('✅ 图标上传成功并已应用')
        }
      } else {
        throw new Error(response.data.msg || '上传失败')
      }
    } catch (error) {
      console.error('图标上传失败:', error)
      setConfirmModal({
        isOpen: true,
        title: '上传失败',
        message: '图标上传失败: ' + (error.response?.data?.msg || error.message),
        onConfirm: () => setConfirmModal({ isOpen: false }),
        onCancel: null,
        type: 'danger'
      })
    } finally {
      setIsUploadingIcon(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const handleContainerAction = async (action) => {
    try {
      setIsActionProcessing(true);
      setCurrentAction(action);

      // 调用传入的onAction函数执行实际操作
      if (action === 'update') {
        await onUpdate(container.id);
      } else {
        await onAction(container.id, action);
      }

      // 无效化查询以触发重新获取数据
      await queryClient.invalidateQueries({ queryKey: [deviceId, 'containers'] })

      setIsActionProcessing(false);
      setCurrentAction('');
    } catch (error) {
      console.error('操作失败:', error);
      setIsActionProcessing(false);
      setCurrentAction('');
    }
  };

  const handleRename = async () => {
    if (name !== currentContainer.name) {
      try {
        setIsRenaming(true)
        console.log(`重命名容器: ${currentContainer.name} -> ${name}`)

        await onRename(container.id, name)

        // 无效化查询以触发重新获取数据
        await queryClient.invalidateQueries({ queryKey: [deviceId, 'containers'] })

        // 更新当前容器状态
        setCurrentContainer({ ...currentContainer, name: name })
        // 同时更新表单中的名称
        setName(name);

        console.log('✅ 容器重命名成功')
        setIsRenaming(false)
      } catch (error) {
        console.error('重命名失败:', error)
        setIsRenaming(false)
      }
    }
  }

  const handleSave = async () => {
    // 如果镜像tag发生变化，则更新容器
    if (currentContainer.composeProject) { onOpenCompose?.(); return }
    if (imageNameAndTag !== currentContainer.usingImage) {
      try {
        setIsUpdating(true)

        console.log(`开始更新容器镜像: ${currentContainer.name}`)
        console.log(`原镜像: ${currentContainer.usingImage}`)
        console.log(`新镜像: ${imageNameAndTag}`)

        // 直接调用API更新容器
        const response = await containerAPI.updateContainer(
          container.id,
          container.name,
          imageNameAndTag,
          true // 删除旧容器
        )

        console.log('更新容器响应:', response.data)

        if (response.data.code === 200 || response.data.code === 0) {
          const taskID = response.data.data?.taskID

          if (taskID) {
            // 如果返回了taskID，我们需要触发进度轮询
            console.log('更新任务已创建，taskID:', taskID)

            // 关闭弹窗
            onClose()

            // 触发父组件中的进度轮询
            onUpdate(container.id, taskID)

            console.log('✅ 容器更新任务已启动，请在列表中查看进度')
          } else {
            // 没有taskID，更新完成
            await queryClient.invalidateQueries({ queryKey: [deviceId, 'containers'] })
            setImageNameAndTag(imageNameAndTag) // 更新本地状态
            console.log('✅ 容器镜像更新完成')
          }
        } else {
          throw new Error(response.data.msg || '更新失败')
        }

        setIsUpdating(false)
      } catch (error) {
        console.error('更新容器镜像失败:', error)
        // 增加超时错误的处理
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
          console.error(`更新操作已提交，但连接超时。请稍后手动刷新页面查看操作结果`)
          // 即使超时也关闭弹窗并触发轮询，因为操作可能仍在进行中
          onClose()
          alert('更新请求超时，结果尚未确定，请到当前设备任务列表查看；不会自动重试。')
        }
        setIsUpdating(false)
      }
    }
  }





  // 获取状态指示器颜色
  const getStatusIndicatorColor = (status) => {
    const statusConfig = {
      running: 'bg-green-500',
      stopped: 'bg-red-500',
      restarting: 'bg-yellow-500',
      paused: 'bg-blue-500'
    }

    return statusConfig[status?.toLowerCase()] || 'bg-gray-500'
  }

  // 获取容器图标 - 与列表显示逻辑一致
  const getContainerIcon = () => {
    let iconUrl = currentContainer.iconUrl;

    // 如果容器没有自定义图标，则查找镜像图标
    if (!iconUrl && currentContainer.usingImage) {
      // 优先使用内置logo配置（不依赖localStorage）
      const builtInLogo = getImageLogo(currentContainer.usingImage);
      if (builtInLogo) {
        iconUrl = builtInLogo;
      } else {
        // 如果没有内置logo，则尝试从用户自定义中查找
        // const imageLogos = JSON.parse(localStorage.getItem(`docker_copilot_image_logos:${deviceId}`) || '{}');
        const imageLogos = customIcons;
        const imageFullName = currentContainer.usingImage;

        if (imageLogos[imageFullName]) {
          iconUrl = imageLogos[imageFullName];
        } else {
          // 降级匹配逻辑
          const imageName = imageFullName.split(':')[0];
          for (const [imageId, logoUrl] of Object.entries(imageLogos)) {
            if (imageId === imageName || imageFullName.startsWith(imageId)) {
              iconUrl = logoUrl;
              break;
            }
          }
        }
      }
    }

    const IconContent = () => {
      if (iconUrl) {
        return (
          <DeviceImage
            src={iconUrl}
            alt={currentContainer.name}
            className="h-12 w-12 rounded-xl object-cover"
            onError={(e) => {
              e.target.style.display = 'none';
              e.target.nextSibling.style.display = 'flex';
            }}
          />
        );
      }
      return null;
    };

    const FallbackIcon = () => (
      <div className="h-12 w-12 bg-gradient-to-r from-blue-500 to-purple-600 rounded-xl flex items-center justify-center text-white" style={{ display: iconUrl ? 'none' : 'flex' }}>
        <Package className="h-6 w-6" />
      </div>
    );

    return (
      <div
        className="relative group cursor-pointer"
        onClick={() => !isUploadingIcon && fileInputRef.current?.click()}
        title="点击上传自定义图标"
      >
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleIconUpload}
          className="hidden"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
        />

        <IconContent />
        <FallbackIcon />

        {/* 悬停覆盖层 */}
        <div className="absolute inset-0 bg-black bg-opacity-50 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          {isUploadingIcon ? (
            <RefreshCw className="h-5 w-5 text-white animate-spin" />
          ) : (
            <Upload className="h-5 w-5 text-white" />
          )}
        </div>
      </div>
    );
  };

  return (
    <Dialog title="容器详情" className="max-w-md" onClose={onClose}>
        {/* 弹窗头部 */}
        <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <div className="flex justify-between items-center">
            <div>
              <div className="flex items-center mt-1">
                {getContainerIcon()}
                {/* 状态指示器竖线 */}
                <div className="flex flex-col items-center justify-center h-full ml-3">
                  <div className={cn(
                    "w-1 h-8 rounded-full",
                    getStatusIndicatorColor(currentContainer.status)
                  )}></div>
                </div>
                <div className="ml-3">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    {currentContainer.name}
                  </span>
                  <div className="flex items-center mt-1">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {currentContainer.id.substring(0, 12)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 弹窗内容 */}
        <div className="px-6 py-4 space-y-4">
          {currentContainer.composeProject && <button type="button" onClick={onOpenCompose} className="inline-flex items-center gap-2 max-w-full text-sm text-primary-600 dark:text-primary-400 hover:underline" title="编辑项目">
            <Boxes className="h-4 w-4 flex-shrink-0" /><span className="truncate">{currentContainer.composeProject}{currentContainer.composeService && ` / ${currentContainer.composeService}`}</span>
          </button>}
          {/* 容器名称 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              容器名称
            </label>
            <div className="flex space-x-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input flex-1"
                placeholder="输入容器名称"
              />
              <button
                onClick={handleRename}
                disabled={isRenaming || (name === currentContainer.name) || isActionProcessing || isUpdating}
                className={`px-3 py-2 text-sm rounded-lg transition-colors ${isRenaming || (name === currentContainer.name)
                  ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-400'
                  : 'bg-primary-600 text-white hover:bg-primary-700 dark:bg-primary-500 dark:hover:bg-primary-600'
                  }`}
              >
                {isRenaming ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
                    重命名中
                  </>
                ) : '重命名'}
              </button>
            </div>
          </div>

          {/* 镜像信息 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              镜像名称和标签
            </label>
            <div className="flex space-x-2">
              <input
                type="text"
                value={imageNameAndTag}
                onChange={(e) => setImageNameAndTag(e.target.value)}
                className="input flex-1"
                placeholder="例如: nginx:latest"
                disabled={isActionProcessing || isUpdating}
                readOnly={!!currentContainer.composeProject}
              />
              <button
                onClick={handleSave}
                disabled={isUpdating || (!currentContainer.composeProject && ((imageNameAndTag === currentContainer.usingImage) || !imageNameAndTag.trim()))}
                className={`px-3 py-2 text-sm rounded-lg transition-colors flex items-center ${isUpdating || (!currentContainer.composeProject && ((imageNameAndTag === currentContainer.usingImage) || !imageNameAndTag.trim()))
                  ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-400'
                  : 'bg-primary-600 text-white hover:bg-primary-700 dark:bg-primary-500 dark:hover:bg-primary-600'
                  }`}
              >
                {isUpdating ? (
                  <>
                    <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                    更新中
                  </>
                ) : (
                  currentContainer.composeProject ? '编辑项目' : '更换镜像'
                )}
              </button>
            </div>
            {!currentContainer.composeProject && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              修改镜像后点击"更换镜像"按钮将重新创建容器
            </p>}
          </div>
        </div>

        {/* 弹窗底部操作按钮 */}
        <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4 bg-gray-50 dark:bg-gray-700/30">
          <div className="flex justify-end gap-2">

            <div className="flex gap-2 w-full sm:w-auto">
              <button
                onClick={() => onUpdate(container.id)}
                disabled={isActionProcessing || isUpdating}
                className={`flex-1 sm:flex-none px-2 sm:px-4 py-2 text-sm rounded-lg transition-colors flex items-center justify-center sm:justify-start gap-1 sm:gap-2 ${isActionProcessing && currentAction === 'update'
                  ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-400'
                  : 'bg-purple-600 text-white hover:bg-purple-700 dark:bg-purple-500 dark:hover:bg-purple-600'
                  }`}
                title="更新"
              >
                {isActionProcessing && currentAction === 'update' ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
                    <span>更新中</span>
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4 flex-shrink-0" />
                    <span>更新</span>
                  </>
                )}
              </button>

              {currentContainer.status === 'running' ? (
                <>
                  <button
                    onClick={() => handleContainerAction('stop')}
                    disabled={isActionProcessing || isUpdating}
                    className={`flex-1 sm:flex-none px-2 sm:px-4 py-2 text-sm rounded-lg transition-colors flex items-center justify-center sm:justify-start gap-1 sm:gap-2 ${isActionProcessing && currentAction === 'stop'
                      ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-400'
                      : 'bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600'
                      }`}
                    title="停止"
                  >
                    {isActionProcessing && currentAction === 'stop' ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
                        <span>停止中</span>
                      </>
                    ) : (
                      <>
                        <Square className="h-4 w-4 flex-shrink-0" />
                        <span>停止</span>
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => handleContainerAction('restart')}
                    disabled={isActionProcessing || isUpdating}
                    className={`flex-1 sm:flex-none px-2 sm:px-4 py-2 text-sm rounded-lg transition-colors flex items-center justify-center sm:justify-start gap-1 sm:gap-2 ${isActionProcessing && currentAction === 'restart'
                      ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-400'
                      : 'bg-yellow-500 text-white hover:bg-yellow-600 dark:bg-yellow-500 dark:hover:bg-yellow-600'
                      }`}
                    title="重启"
                  >
                    {isActionProcessing && currentAction === 'restart' ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
                        <span>重启中</span>
                      </>
                    ) : (
                      <>
                        <RotateCcw className="h-4 w-4 flex-shrink-0" />
                        <span>重启</span>
                      </>
                    )}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => handleContainerAction('start')}
                  disabled={isActionProcessing || isUpdating}
                  className={`flex-1 sm:flex-none px-2 sm:px-4 py-2 text-sm rounded-lg transition-colors flex items-center justify-center sm:justify-start gap-1 sm:gap-2 ${isActionProcessing && currentAction === 'start'
                    ? 'bg-gray-200 text-gray-500 cursor-not-allowed dark:bg-gray-700 dark:text-gray-400'
                    : 'bg-green-600 text-white hover:bg-green-700 dark:bg-green-500 dark:hover:bg-green-600'
                    }`}
                  title="启动"
                >
                  {isActionProcessing && currentAction === 'start' ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin flex-shrink-0" />
                      <span>启动中</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 flex-shrink-0" />
                      <span>启动</span>
                    </>
                  )}
                </button>
              )}
            </div>


          </div>
        </div>
    </Dialog>
  )
}
