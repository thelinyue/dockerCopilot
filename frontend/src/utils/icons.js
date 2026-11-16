export const CUSTOM_ICON_PREFIX = '/src/config/image/'
export const ICON_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif'

function splitReference(value) {
  const image = typeof value === 'string' ? value.trim() : ''
  const digest = image.indexOf('@')
  const named = digest >= 0 ? image.slice(0, digest) : image
  const colon = named.lastIndexOf(':')
  const tagStart = colon > named.lastIndexOf('/') ? colon : named.length
  return [named.slice(0, tagStart), image.slice(tagStart)]
}

export function normalizeImageRepository(value) {
  let [repository] = splitReference(value)
  repository = repository.replace(/^(?:docker\.io|index\.docker\.io)\//, '')
  if (repository.startsWith('library/') && repository.split('/').length === 2) repository = repository.slice(8)
  return repository
}

// 旧配置可能对不同标签设置过不同图片；有冲突时只认精确标签，不猜测要保留哪一张。
export function resolveCustomIcon(imageName, customIcons = {}) {
  const repository = normalizeImageRepository(imageName)
  if (!repository) return null
  const entries = Object.entries(customIcons).filter(([name]) => normalizeImageRepository(name) === repository)
  const repositoryEntry = entries.find(([name]) => name === repository) || entries.find(([name]) => !splitReference(name)[1])
  if (repositoryEntry) return repositoryEntry[1]
  const suffix = splitReference(imageName)[1] || ':latest'
  const exact = entries.find(([name]) => splitReference(name)[1] === suffix)
  if (exact) return exact[1]
  const values = new Set(entries.map(([, url]) => url))
  return values.size === 1 ? [...values][0] : null
}

export function resolveImageLogo(imageName, customIcons, builtinIcons) {
  const custom = resolveCustomIcon(imageName, customIcons)
  if (custom) return custom
  const repository = normalizeImageRepository(imageName)
  if (!repository) return null
  const parts = repository.split('/')
  const withoutRegistry = parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost') ? parts.slice(1).join('/') : repository
  return builtinIcons[repository] || builtinIcons[withoutRegistry] || builtinIcons[parts.at(-1)] || null
}

export function normalizeIconMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图标列表格式无效，请检查设备版本后重试')
  if (Object.entries(value).some(([name, url]) => !name || typeof url !== 'string' || !url)) throw new Error('图标列表格式无效，请检查设备配置后重试')
  return value
}

export function iconId({ source, name }) {
  // “|”不能出现在合法镜像名中，避免旧的 custom:7 一类名称被误认成新收藏标识。
  return `${source}|${name}`
}

export function migrateFavorites(saved, entries, customLoaded) {
  if (!Array.isArray(saved)) return []
  const result = new Set()
  for (const item of saved) {
    if (typeof item !== 'string') continue
    if (item.startsWith('builtin|') || item.startsWith('custom|')) result.add(item)
    else {
      // 自定义列表尚未返回时保留旧名称，避免提前迁移丢失离线设备的收藏。
      if (!customLoaded) result.add(item)
      for (const entry of entries) if (entry.name === item) result.add(iconId(entry))
      if (customLoaded && !entries.some(entry => entry.name === item)) result.add(item)
    }
  }
  return [...result]
}

export function validateIconFile(file) {
  if (!file) return '请选择要上传的图片'
  if (file.size > 2 * 1024 * 1024) return '图标文件大小不能超过 2 MiB'
  if (!/\.(png|jpe?g|webp|gif)$/i.test(file.name)) return '仅支持 PNG、JPEG、WebP、GIF，不支持 SVG，请先转换格式'
  return ''
}

export function remapRepositoryFavorites(saved, repository, previousNames, hasImage, builtinNames) {
  if (!Array.isArray(saved)) return []
  let wasFavorite = false
  const next = []
  for (const item of saved) {
    if (typeof item !== 'string') continue
    const custom = item.startsWith('custom|') && normalizeImageRepository(item.slice(7)) === repository
    const legacy = !item.startsWith('builtin|') && previousNames.includes(item)
    if (custom || legacy) {
      wasFavorite = true
      if (legacy && builtinNames.includes(item)) next.push(iconId({ source: 'builtin', name: item }))
    } else next.push(item)
  }
  if (wasFavorite && hasImage) next.push(iconId({ source: 'custom', name: repository }))
  return [...new Set(next)]
}

export function iconFilename(url) {
  return typeof url === 'string' && url.startsWith(CUSTOM_ICON_PREFIX) ? url.slice(CUSTOM_ICON_PREFIX.length) : null
}
