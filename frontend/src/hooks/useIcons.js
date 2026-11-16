import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeviceAPI } from './useDevice.jsx'
import { normalizeIconMap, normalizeImageRepository, CUSTOM_ICON_PREFIX, validateIconFile, remapRepositoryFavorites } from '../utils/icons.js'
import { builtInImageLogos } from '../config/imageLogos.js'

const storageKey = deviceId => `docker_copilot_image_logos:${deviceId}`

function saveLocal(deviceId, icons) {
  try { localStorage.setItem(storageKey(deviceId), JSON.stringify(icons)) }
  catch { /* 存储不可用不影响服务端已成功的操作。 */ }
}

export function useIcons() {
  const { deviceId, imageAPI } = useDeviceAPI()
  const client = useQueryClient()
  const key = [deviceId, 'customIcons']
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const response = await imageAPI.getIcons()
      const icons = normalizeIconMap(response.data.data)
      saveLocal(deviceId, icons)
      return icons
    },
    initialData: () => {
      try {
        const saved = localStorage.getItem(storageKey(deviceId))
        return saved ? normalizeIconMap(JSON.parse(saved)) : undefined
      } catch { return undefined }
    },
    refetchOnMount: true,
  })

  const apply = async (imageName, filename) => {
    const repository = normalizeImageRepository(imageName)
    try {
      const favoritesKey = `docker_copilot_icon_favorites:${deviceId}`
      const previousNames = Object.keys(client.getQueryData(key) || {}).filter(name => normalizeImageRepository(name) === repository)
      const favorites = JSON.parse(localStorage.getItem(favoritesKey) || '[]')
      localStorage.setItem(favoritesKey, JSON.stringify(remapRepositoryFavorites(favorites, repository, previousNames, !!filename, Object.keys(builtInImageLogos))))
    } catch { /* 保留服务端操作结果，收藏存储不可用时由图标库提示。 */ }
    client.setQueryData(key, previous => {
      const next = Object.fromEntries(Object.entries(previous || {}).filter(([name]) => normalizeImageRepository(name) !== repository))
      if (filename) next[repository] = CUSTOM_ICON_PREFIX + filename
      saveLocal(deviceId, next)
      return next
    })
    // 变更已在服务端提交；刷新失败由查询状态展示，不能把保存成功误报成失败。
    await client.invalidateQueries({ queryKey: key })
  }
  const upload = async (file, imageName) => {
    const invalid = validateIconFile(file)
    if (invalid) throw new Error(invalid)
    const response = await imageAPI.uploadIcon(file, imageName)
    await apply(imageName, response.data.data)
    return response.data.msg
  }
  const remove = async imageName => {
    const response = await imageAPI.deleteIcon(imageName)
    await apply(imageName, null)
    return response.data.msg
  }
  const deviceName = deviceId === 'local' ? '本机' : client.getQueryData(['devices'])?.find(device => device.id === deviceId)?.name || '当前设备'
  return { ...query, icons: query.data || {}, deviceName, upload, remove }
}
