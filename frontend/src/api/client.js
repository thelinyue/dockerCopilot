import axios from 'axios'

// 动态获取 API 基础地址
// 优先级：环境变量 > window.__API_BASE_URL > localStorage > 当前主机 > 默认值
function getAPIBaseURL() {
  // 1. 最高优先级：环境变量（构建时注入）
  if (import.meta.env.VITE_API_BASE_URL) {
    console.log('Using build-time API URL:', import.meta.env.VITE_API_BASE_URL)
    return import.meta.env.VITE_API_BASE_URL
  }

  // 2. 检查全局变量（注入的配置）
  if (typeof window !== 'undefined' && window.__API_BASE_URL) {
    console.log('Using injected API URL:', window.__API_BASE_URL)
    return window.__API_BASE_URL
  }

  // 3. 检查 localStorage（用户保存的地址）
  const savedURL = localStorage.getItem('api_base_url')
  if (savedURL) {
    console.log('Using localStorage API URL:', savedURL)
    return savedURL
  }

  // 4. 使用当前主机
  if (typeof window !== 'undefined' && window.location.host) {
    const currentHostURL = `${window.location.protocol}//${window.location.host}`
    console.log('Using current host API URL:', currentHostURL)
    return currentHostURL
  }

  // 5. 最后的默认值
  const fallbackURL = 'http://localhost'
  console.log('Using fallback API URL:', fallbackURL)
  return fallbackURL
}

const API_BASE_URL = getAPIBaseURL()

// 创建axios实例
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 35000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器 - 添加认证token
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('docker_copilot_token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 响应拦截器 - 处理认证过期
apiClient.interceptors.response.use(
  (response) => {
    const code = response.data?.code
    if (typeof code === 'number' && code !== 200 && code !== 0) {
      const error = new Error(response.data.msg || '操作失败')
      error.response = response
      return Promise.reject(error)
    }
    return response
  },
  (error) => {
    if (error.response?.data?.msg) error.message = error.response.data.msg
    else if (error.code === 'ECONNABORTED') error.message = '请求超时，变更结果尚未确定，请在原设备任务列表确认，避免重复提交。'
    else if (error.code === 'ERR_NETWORK') error.message = '无法连接服务，请检查设备地址、网络或跨域配置。'
    if (error.response?.status === 401) {
      // 只在有token的情况下移除它
      if (localStorage.getItem('docker_copilot_token')) {
        localStorage.removeItem('docker_copilot_token')
        // 触发自定义事件通知应用认证状态变化
        window.dispatchEvent(new CustomEvent('authChange', { detail: { authenticated: false } }))
      }
    }
    return Promise.reject(error)
  }
)

// 认证相关API
export const authAPI = {
  login: (secretKey) => {
    const formData = new FormData()
    formData.append('secretKey', secretKey)
    return apiClient.post('/api/auth', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
  },
}

export function createDeviceAPI(deviceId = 'local') {
  // 每个组件持有固定设备的 API，异步轮询及批量操作不会跟随设备选择变化。
  const rootClient = apiClient
  const request = (method, url, data, config = {}) => rootClient.request({
    ...config, method, url, data,
    headers: { ...config.headers, 'X-DockerCopilot-Device-ID': deviceId },
  })
  const scopedClient = {
    get: (url, config) => request('get', url, undefined, config),
    delete: (url, config) => request('delete', url, undefined, config),
    post: (url, data, config) => request('post', url, data, config),
    put: (url, data, config) => request('put', url, data, config),
  }
  // 版本相关API
  const versionAPI = {
    getVersion: (type) => {
      // 如果type参数为空，则不添加查询参数
      if (!type) {
        return scopedClient.get('/api/version')
      }
      return scopedClient.get(`/api/version?type=${type}`)
    },
    updateProgram: () => scopedClient.put('/api/program'),
  }

  // 容器相关API
  const containerAPI = {
    getContainers: () => scopedClient.get('/api/containers'),
    startContainer: (id) => scopedClient.post(`/api/container/${id}/start`),
    stopContainer: (id) => scopedClient.post(`/api/container/${id}/stop`),
    restartContainer: (id) => scopedClient.post(`/api/container/${id}/restart`),
    renameContainer: (id, newName) => {
      return scopedClient.post(`/api/container/${id}/rename?newName=${encodeURIComponent(newName)}`)
    },
    updateContainer: (id, containerName, imageNameAndTag, delOldContainer) => {
      const formData = new FormData()
      formData.append('containerName', containerName)
      formData.append('imageNameAndTag', imageNameAndTag)
      if (delOldContainer !== undefined) formData.append('delOldContainer', delOldContainer ? 'true' : 'false')
      return scopedClient.post(`/api/container/${id}/update`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
    },
  }

  // 镜像相关API
  const imageAPI = {
    getImages: () => scopedClient.get('/api/images'),
    getIcons: () => scopedClient.get('/api/icons'),
    iconURL: (filename) => new URL(`/icons/${encodeURIComponent(deviceId)}/${encodeURIComponent(filename)}`, API_BASE_URL).href,
    deleteIcon: (imageName) => scopedClient.delete(`/api/icons?imageName=${encodeURIComponent(imageName)}`),
    pruneImages: (type) => scopedClient.post('/api/image/prune', { type }, { timeout: 120000 }),
    deleteImage: (id, force = false) => scopedClient.delete(`/api/image/${id}?force=${force}`),
    uploadIcon: (file, imageName, containerName) => {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('imageName', imageName)
      if (containerName) {
        formData.append('containerName', containerName)
      }
      return scopedClient.post('/api/icons', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
    },
  }

  // 进度查询API
  const progressAPI = {
    getProgress: (taskid) => scopedClient.get(`/api/progress/${taskid}`),
  }


  const result = async (promise) => (await promise).data.data
  const managementAPI = {
    info: () => result(scopedClient.get('/api/node/info')),
    settings: () => result(scopedClient.get('/api/settings')),
    saveSettings: (settings) => result(scopedClient.put('/api/settings', settings)),
    testNotification: (bark) => result(scopedClient.post('/api/notifications/test', bark)),
    tasks: () => result(scopedClient.get('/api/tasks')),
    check: () => result(scopedClient.post('/api/checks')),
    autoUpdate: () => result(scopedClient.post('/api/auto-update')),
    projects: () => result(scopedClient.get('/api/compose/projects')),
    importProject: (name, files) => result(scopedClient.post('/api/compose/projects', { name, files })),
    readFile: (id, index) => result(scopedClient.get(`/api/compose/projects/${id}/files/${index}`)),
    validateFile: (id, index, content, signal) => result(scopedClient.post(`/api/compose/projects/${id}/files/${index}/validate`, { content }, { signal })),
    saveFile: (id, index, original, content) => result(scopedClient.put(`/api/compose/projects/${id}/files/${index}`, { original, content })),
    composeAction: (id, action, services = []) => result(scopedClient.post(`/api/compose/projects/${id}/actions`, { action, services })),
    icon: (name, signal) => scopedClient.get(`/api/icon-file?name=${encodeURIComponent(name)}`, { responseType: 'blob', signal }),
  }
  return { versionAPI, containerAPI, imageAPI, progressAPI, managementAPI }
}

export const deviceAPI = {
  list: async () => (await apiClient.get('/api/devices', { headers: { 'X-DockerCopilot-Device-ID': 'local' } })).data.data,
  save: async (device) => (await apiClient.request({ method: device.id ? 'put' : 'post', url: '/api/devices' + (device.id ? '/' + device.id : ''), data: device, headers: { 'X-DockerCopilot-Device-ID': 'local' } })).data.data,
  remove: (id) => apiClient.delete(`/api/devices/${id}`, { headers: { 'X-DockerCopilot-Device-ID': 'local' } }),
  test: async (id) => (await apiClient.post(`/api/devices/${id}/test`, null, { headers: { 'X-DockerCopilot-Device-ID': 'local' } })).data.data,
}

// GitHub API - 用于检查前端更新
export const githubAPI = {
  /**
   * 获取 GitHub 仓库的最新 Release
   * @param {string} owner - 仓库所有者
   * @param {string} repo - 仓库名称
   * @returns {Promise} 返回最新 Release 信息
   */
  getLatestRelease: async (owner, repo) => {
    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
        timeout: 5000,
      })
      return response.data
    } catch (error) {
      console.warn('获取 GitHub 最新版本失败:', error.message)
      throw error
    }
  },

  /**
   * 获取 GitHub 仓库的所有 Releases
   * @param {string} owner - 仓库所有者
   * @param {string} repo - 仓库名称
   * @param {number} perPage - 每页返回数量
   * @returns {Promise} 返回 Release 列表
   */
  getReleases: async (owner, repo, perPage = 5) => {
    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/releases`, {
        params: { per_page: perPage },
        timeout: 5000,
      })
      return response.data
    } catch (error) {
      console.warn('获取 GitHub Releases 列表失败:', error.message)
      throw error
    }
  },

  /**
   * 获取 GitHub 仓库信息
   * @param {string} owner - 仓库所有者
   * @param {string} repo - 仓库名称
   * @returns {Promise} 返回仓库信息
   */
  getRepoInfo: async (owner, repo) => {
    try {
      const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
        timeout: 5000,
      })
      return response.data
    } catch (error) {
      console.warn('获取 GitHub 仓库信息失败:', error.message)
      throw error
    }
  },
}

export default apiClient
