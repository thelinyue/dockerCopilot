export const automationFields = ['checkCron', 'updateCron', 'startupCheck', 'autoUpdate', 'excludedContainers', 'excludedServices', 'httpProxy', 'httpsProxy']

// 仅提交实际修改的字段，避免分类之间的旧查询快照覆盖新设置。
export function changedFields(original, draft, fields = Object.keys(draft)) {
  return Object.fromEntries(fields.filter(key => JSON.stringify(original[key]) !== JSON.stringify(draft[key])).map(key => [key, draft[key]]))
}

export function notificationPatch(original, draft) {
  const { bark, ...events } = draft
  const patch = changedFields(original, events)
  const barkPatch = changedFields(original.bark, { serverURL: bark.serverURL })
  if (bark.deviceKey.trim()) barkPatch.deviceKey = bark.deviceKey.trim()
  if (Object.keys(barkPatch).length) patch.bark = barkPatch
  return patch
}
