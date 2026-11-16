import { iconFilename } from '../utils/icons.js'

// 缓存 Blob 而非对象 URL；相同设备、相同文件共享请求，各视图自行管理 URL 生命周期。
export function iconAssetOptions(deviceId, managementAPI, url) {
  const filename = iconFilename(url)
  return {
    queryKey: [deviceId, 'iconBlob', filename],
    queryFn: async ({ signal }) => (await managementAPI.icon(filename, signal)).data,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: false,
  }
}
