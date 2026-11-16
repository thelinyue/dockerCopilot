import test from 'node:test'
import assert from 'node:assert/strict'
import { changedFields, automationFields, notificationPatch } from './settings.js'

test('自动更新仅提交实际修改字段，保留其他分类和旧 Cron', () => {
  const original = { checkCron: '0 3 * * *', updateCron: '0 3 * * *', httpsProxy: '', notifications: { enabled: false } }
  assert.deepEqual(changedFields(original, { ...original }, automationFields), {})
  assert.deepEqual(changedFields(original, { ...original, httpsProxy: 'http://proxy:7890', notifications: { enabled: true } }, automationFields), { httpsProxy: 'http://proxy:7890' })
})

test('通知嵌套局部保存不提交密钥掩码或其他通知开关', () => {
  const original = { enabled: false, checkFailed: true, updateSucceeded: true, bark: { serverURL: 'https://api.day.app', hasKey: true } }
  const draft = { ...original, bark: { ...original.bark, deviceKey: '' } }
  assert.deepEqual(notificationPatch(original, draft), {})
  assert.deepEqual(notificationPatch(original, { ...draft, enabled: true }), { enabled: true })
  assert.deepEqual(notificationPatch(original, { ...draft, bark: { ...draft.bark, serverURL: 'https://bark.example/prefix', deviceKey: ' replacement ' } }), { bark: { serverURL: 'https://bark.example/prefix', deviceKey: 'replacement' } })
})
