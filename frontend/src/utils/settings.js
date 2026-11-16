export const automationFields = ['checkCron', 'updateCron', 'startupCheck', 'autoUpdate', 'excludedContainers', 'excludedServices', 'httpProxy', 'httpsProxy']

// 现有接口只返回错误文字；仅将已知校验提示关联到输入项，其余错误集中展示。
export function settingsErrorTarget({ group, message }) {
  if (message.startsWith('请填写 Bark 设备密钥')) return 'deviceKey'
  if (message.startsWith('Bark 服务器地址无效')) return 'serverURL'
  if (message.startsWith('定时表达式')) return ['checkCron', 'updateCron'].includes(group) ? group : 'schedule'
  if (message.startsWith('代理地址无效') || message.startsWith('代理地址包含密码掩码')) return 'proxy'
  return undefined
}

// 仅提交实际修改的字段，避免分类之间的旧查询快照覆盖新设置。
export function changedFields(original, draft, fields = Object.keys(draft)) {
  return Object.fromEntries(fields.filter(key => JSON.stringify(original[key]) !== JSON.stringify(draft[key])).map(key => [key, draft[key]]))
}

export function validateProxyPatch(patch) {
  for (const key of ['httpProxy', 'httpsProxy']) {
    if (!(key in patch)) continue
    let credential
    try { credential = decodeURIComponent(new URL(patch[key]).password) } catch { continue /* 地址格式由服务端校验。 */ }
    if (credential === '********') throw new Error('代理地址包含密码掩码，修改代理时请重新填写完整地址和密码。')
  }
  return patch
}

export function applyAutomationPatch(data, patch) {
  const publicPatch = { ...patch }
  if (data.nextRuns.schedule !== undefined && ['checkCron', 'updateCron', 'autoUpdate'].some(key => key in patch)) {
    const cron = patch.checkCron ?? patch.updateCron ?? (data.settings.autoUpdate ? data.settings.updateCron : data.settings.checkCron)
    publicPatch.checkCron = publicPatch.updateCron = cron
  }
  for (const key of ['httpProxy', 'httpsProxy']) {
    if (!publicPatch[key]) continue
    let url
    try { url = new URL(publicPatch[key]) } catch {
      // 浏览器与 Go 的 URL 解析边界不同；写入已成功时等待脱敏回读，不能回填明文或误报失败。
      publicPatch[key] = data.settings[key]
      continue
    }
    if (url.username || url.password) {
      url.password = '********'
      publicPatch[key] = url.toString()
    }
  }
  return { ...data, settings: { ...data.settings, ...publicPatch } }
}

export function selectNotifications(data) {
  if (!data.settings.notifications) return { ...data, settings: undefined }
  const { bark, ...settings } = data.settings.notifications
  return { ...data, settings: { ...settings, serverURL: bark.serverURL, deviceKey: '', hasKey: bark.hasKey } }
}

export function encodeNotifications(values) {
  const { serverURL, deviceKey, ...patch } = values
  const bark = {}
  if (serverURL !== undefined) bark.serverURL = serverURL
  if (deviceKey?.trim()) bark.deviceKey = deviceKey.trim()
  if (Object.keys(bark).length) patch.bark = bark
  return Object.keys(patch).length ? { notifications: patch } : {}
}

export function applyNotificationPatch(data, { notifications: { bark, ...patch } }) {
  const saved = data.settings.notifications
  const publicBark = { ...saved.bark }
  if (bark?.serverURL !== undefined) publicBark.serverURL = bark.serverURL.trim().replace(/\/+$/, '')
  if (bark?.deviceKey) publicBark.hasKey = true
  return { ...data, settings: { ...data.settings, notifications: { ...saved, ...patch, bark: publicBark } } }
}
