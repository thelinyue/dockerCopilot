import test from 'node:test'
import assert from 'node:assert/strict'
import { changedFields, automationFields, validateProxyPatch, applyAutomationPatch, selectNotifications, encodeNotifications, applyNotificationPatch, settingsErrorTarget } from './settings.js'

test('设置校验提示关联实际输入项，启用推送缺少密钥时定位密钥框', () => {
  assert.equal(settingsErrorTarget({ group: 'enabled', message: '请填写 Bark 设备密钥，可在 Bark App 中获取' }), 'deviceKey')
  assert.equal(settingsErrorTarget({ group: 'bark', message: 'Bark 服务器地址无效，请填写 http(s)://主机:端口' }), 'serverURL')
  assert.equal(settingsErrorTarget({ group: 'schedule', message: '定时表达式无效，请使用五段 Cron' }), 'schedule')
  assert.equal(settingsErrorTarget({ group: 'updateCron', message: '定时表达式必须为五段 Cron，时区由设备 TZ 设置' }), 'updateCron')
  assert.equal(settingsErrorTarget({ group: 'proxy', message: '代理地址包含密码掩码，修改代理时请重新填写完整地址和密码。' }), 'proxy')
})

test('网络、服务和未知错误保留集中提示，不按修改字段误标输入无效', () => {
  for (const message of ['无法连接服务，请检查设备地址、网络或跨域配置。', '设置保存请求超时，结果尚未确认', '保存设置失败：permission denied', '代理连接服务暂时不可用']) {
    assert.equal(settingsErrorTarget({ group: 'bark', message }), undefined)
    assert.equal(settingsErrorTarget({ group: 'proxy', message }), undefined)
  }
})

test('GitHub 加速地址单独校验、脱敏和规范化，不改写检测代理与计划', () => {
  const original = { settings: { checkCron: '30 * * * *', updateCron: '0 3 * * *', httpProxy: 'http://registry:7890', githubProxy: '', keepOldContainer: false }, nextRuns: { schedule: 'next' } }
  const patch = validateProxyPatch({ githubProxy: ' https://user:fixture-credential@mirror.example/prefix/// ' })
  assert.equal(patch.githubProxy, 'https://user:fixture-credential@mirror.example/prefix')
  const cached = applyAutomationPatch(original, { ...patch, keepOldContainer: true })
  assert.equal(cached.settings.keepOldContainer, true)
  assert.equal(cached.settings.httpProxy, original.settings.httpProxy)
  assert.equal(cached.settings.updateCron, original.settings.updateCron)
  assert.equal(JSON.stringify(cached).includes('fixture-credential'), false)
  assert.match(cached.settings.githubProxy, /\*{8}/)
  assert.throws(() => validateProxyPatch({ githubProxy: cached.settings.githubProxy }), /GitHub 加速地址包含密码掩码/)
  assert.equal(settingsErrorTarget({ group: 'githubProxy', message: 'GitHub 加速地址无效，请填写 http(s)://主机:端口' }), 'githubProxy')
  assert.deepEqual(validateProxyPatch({ githubProxy: '  ' }), { githubProxy: '' })
  assert.equal(applyAutomationPatch(cached, { githubProxy: '' }).settings.githubProxy, '')
  assert.deepEqual(changedFields(original.settings, { ...original.settings, keepOldContainer: true }, automationFields), { keepOldContainer: true })
})

test('自动更新仅提交实际修改字段，保留其他分类和旧 Cron', () => {
  const original = { checkCron: '0 3 * * *', updateCron: '0 3 * * *', httpsProxy: '', notifications: { enabled: false } }
  assert.deepEqual(changedFields(original, { ...original }, automationFields), {})
  assert.deepEqual(changedFields(original, { ...original, httpsProxy: 'http://proxy:7890', notifications: { enabled: true } }, automationFields), { httpsProxy: 'http://proxy:7890' })
})

test('代理认证掩码禁止写入，保存后的公共缓存只包含掩码', () => {
  const original = { settings: { httpProxy: '', httpsProxy: '' }, nextRuns: {} }
  const patch = { httpProxy: 'http://user:private-value@proxy:7890', httpsProxy: 'http://user:private-value@proxy:7890' }
  assert.equal(validateProxyPatch(patch), patch)
  const cached = applyAutomationPatch(original, patch)
  assert.notEqual(cached.settings.httpProxy, patch.httpProxy)
  assert.match(cached.settings.httpProxy, /\*{8}/)
  assert.throws(() => validateProxyPatch({ httpsProxy: 'http://user:********@proxy:7890' }), /密码掩码/)
  assert.throws(() => validateProxyPatch({ httpsProxy: 'http://user:%2A%2A%2A%2A%2A%2A%2A%2A@proxy:7890' }), /密码掩码/)
  assert.deepEqual(applyAutomationPatch(original, { httpsProxy: '' }).settings, original.settings)
  const outsideBrowserRange = applyAutomationPatch(original, { httpsProxy: 'http://user:fixture-credential@proxy:65536' })
  assert.equal(outsideBrowserRange.settings.httpsProxy, '')
})

test('切换模式的公共快照沿用原频率，其他分类不归一旧双 Cron', () => {
  const data = { settings: { checkCron: '30 * * * *', updateCron: '0 3 * * *', autoUpdate: false }, nextRuns: { schedule: 'next' } }
  const switched = applyAutomationPatch(data, { autoUpdate: true })
  assert.equal(switched.settings.checkCron, data.settings.checkCron)
  assert.equal(switched.settings.updateCron, data.settings.checkCron)
  assert.equal(applyAutomationPatch(data, { startupCheck: false }).settings.updateCron, data.settings.updateCron)
  const legacy = applyAutomationPatch({ ...data, nextRuns: {} }, { autoUpdate: true })
  assert.equal(legacy.settings.updateCron, data.settings.updateCron)
})

test('通知连接局部提交、空密钥保留，公共缓存不存储明文密钥', () => {
  const data = { settings: { notifications: { enabled: false, checkFailed: true, bark: { serverURL: 'https://api.day.app', hasKey: false } } } }
  const patch = encodeNotifications({ serverURL: ' https://bark.example/path/// ', deviceKey: ' private-test-key ' })
  assert.deepEqual(patch, { notifications: { bark: { serverURL: ' https://bark.example/path/// ', deviceKey: 'private-test-key' } } })
  const cached = applyNotificationPatch(data, patch)
  assert.equal(JSON.stringify(cached).includes('private-test-key'), false)
  const selected = selectNotifications(cached).settings
  assert.equal(selected.deviceKey, '')
  assert.equal(selected.hasKey, true)
  assert.equal(selected.serverURL, 'https://bark.example/path')
  assert.deepEqual(encodeNotifications({ deviceKey: '  ' }), {})
  assert.deepEqual(encodeNotifications({ enabled: true }), { notifications: { enabled: true } })
  assert.equal(selectNotifications({ settings: {} }).settings, undefined)
})

test('通知嵌套局部保存不提交密钥掩码或其他通知开关', () => {
  const original = selectNotifications({ settings: { notifications: { enabled: false, checkFailed: true, updateSucceeded: true, bark: { serverURL: 'https://api.day.app', hasKey: true } } } }).settings
  const patch = draft => encodeNotifications(changedFields(original, draft))
  assert.deepEqual(patch({ ...original }), {})
  assert.deepEqual(patch({ ...original, enabled: true }), { notifications: { enabled: true } })
  assert.deepEqual(patch({ ...original, serverURL: 'https://bark.example/prefix', deviceKey: ' replacement ' }), { notifications: { bark: { serverURL: 'https://bark.example/prefix', deviceKey: 'replacement' } } })
})
