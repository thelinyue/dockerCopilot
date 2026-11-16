import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as settle } from 'node:timers/promises'
import { createAutosave } from './autosave.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const fixture = (initial, implementation) => {
  let stored = { ...initial }
  const requests = []
  const controller = createAutosave({ initial, save: async (patch, group) => {
    requests.push({ patch, group })
    await implementation?.(patch, group)
    stored = { ...stored, ...patch }
    return { ...stored }
  } })
  return { controller, requests, stored: () => stored }
}

test('开关立即局部保存，同值修改和读取刷新不触发写入', async () => {
  const { controller, requests } = fixture({ enabled: false, proxy: '' })
  controller.change('enabled', { enabled: true })
  await settle()
  assert.deepEqual(requests, [{ patch: { enabled: true }, group: 'enabled' }])
  assert.equal(controller.snapshot().dirty, false)
  controller.sync({ enabled: true, proxy: 'server-value' })
  controller.change('enabled', { enabled: true })
  await controller.flush()
  assert.equal(requests.length, 1)
})

test('文本 500 毫秒防抖，只发送停顿后的最新输入', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { controller, requests } = fixture({ proxy: '' })
  controller.change('proxy', { proxy: 'first' }, 500)
  t.mock.timers.tick(400)
  controller.change('proxy', { proxy: 'latest' }, 500)
  t.mock.timers.tick(499)
  await settle()
  assert.equal(requests.length, 0)
  t.mock.timers.tick(1)
  await settle()
  assert.deepEqual(requests.map(item => item.patch), [{ proxy: 'latest' }])
})

test('失焦提前提交，未发送前改回原值不写入', async () => {
  const { controller, requests } = fixture({ proxy: '' })
  controller.change('proxy', { proxy: 'temporary' }, 500)
  controller.change('proxy', { proxy: '' }, 500)
  assert.equal(await controller.flush(), true)
  assert.equal(requests.length, 0)
  controller.focus('proxy')
  controller.change('proxy', { proxy: 'final' }, 500)
  assert.equal(await controller.blur('proxy'), true)
  assert.deepEqual(requests.map(item => item.patch), [{ proxy: 'final' }])
})

test('慢请求期间改回原值，仍须在首个写入后提交恢复值', async () => {
  const first = deferred()
  const { controller, requests, stored } = fixture({ enabled: false }, () => requests.length === 1 ? first.promise : undefined)
  controller.change('enabled', { enabled: true })
  await settle()
  controller.change('enabled', { enabled: false })
  const flushed = controller.flush()
  assert.equal(requests.length, 1)
  first.resolve()
  assert.equal(await flushed, true)
  assert.deepEqual(requests.map(item => item.patch), [{ enabled: true }, { enabled: false }])
  assert.equal(stored().enabled, false)
})

test('请求串行，等待期间合并同组最新值并保留其他组', async () => {
  const first = deferred()
  const { controller, requests } = fixture({ cron: 'old', enabled: false }, () => requests.length === 1 ? first.promise : undefined)
  controller.change('cron', { cron: 'first' })
  await settle()
  controller.change('cron', { cron: 'discarded' })
  controller.change('cron', { cron: 'latest' })
  controller.change('enabled', { enabled: true })
  assert.equal(requests.length, 1)
  assert.equal(controller.snapshot().form.cron, 'latest')
  first.resolve()
  assert.equal(await controller.flush(), true)
  assert.deepEqual(requests.map(item => item.patch), [{ cron: 'first' }, { cron: 'latest' }, { enabled: true }])
})

test('超时结果不确定时，即使改回原值也再次提交确认', async () => {
  const first = deferred()
  const { controller, requests, stored } = fixture({ enabled: false }, () => requests.length === 1 ? first.promise : undefined)
  controller.change('enabled', { enabled: true })
  await settle()
  controller.change('enabled', { enabled: false })
  first.reject(Object.assign(new Error('结果尚未确定'), { uncertain: true }))
  assert.equal(await controller.flush(), true)
  assert.deepEqual(requests.map(item => item.patch), [{ enabled: true }, { enabled: false }])
  assert.equal(stored().enabled, false)
})

test('无效输入不阻止独立开关保存，失败不无限重试', async () => {
  const { controller, requests } = fixture({ cron: 'old', enabled: false }, patch => {
    if (patch.cron === 'invalid') throw new Error('定时表达式无效')
  })
  controller.change('cron', { cron: 'invalid' })
  controller.change('enabled', { enabled: true })
  assert.equal(await controller.flush(), false)
  assert.equal(controller.snapshot().form.cron, 'invalid')
  assert.equal(controller.snapshot().form.enabled, true)
  assert.equal(controller.snapshot().errors[0].message, '定时表达式无效')
  await controller.flush()
  assert.equal(requests.length, 2)
  controller.change('cron', { cron: 'valid' })
  assert.equal(await controller.flush(), true)
})

test('旧请求失败不污染后续输入，重试只重新提交失败组', async () => {
  const first = deferred()
  let fail = true
  const { controller, requests } = fixture({ proxy: '', enabled: false }, async patch => {
    if (requests.length === 1) await first.promise
    if (patch.proxy && fail) throw new Error('网络异常')
  })
  controller.change('proxy', { proxy: 'old' })
  await settle()
  controller.change('proxy', { proxy: 'new' })
  first.reject(new Error('旧请求失败'))
  await controller.flush()
  assert.equal(controller.snapshot().errors[0].message, '网络异常')
  fail = false
  await controller.retry()
  assert.equal(controller.snapshot().dirty, false)
  assert.deepEqual(requests.map(item => item.patch), [{ proxy: 'old' }, { proxy: 'new' }, { proxy: 'new' }])
})

test('凭据保存后保持完整输入，继续输入不截断，失焦后清理', async () => {
  let stored = { deviceKey: '', hasKey: false }
  const requests = []
  const controller = createAutosave({ initial: stored, save: async patch => {
    requests.push(patch)
    stored = { deviceKey: '', hasKey: true }
    return stored
  } })
  controller.focus('bark')
  controller.change('bark', { deviceKey: 'first' })
  await controller.flush()
  controller.sync(stored)
  assert.equal(controller.snapshot().form.deviceKey, 'first')
  assert.equal(controller.snapshot().dirty, false)
  controller.change('bark', { deviceKey: 'first-more' })
  await controller.flush()
  assert.equal(controller.snapshot().form.deviceKey, 'first-more')
  await controller.blur('bark')
  assert.equal(controller.snapshot().form.deviceKey, '')
  assert.deepEqual(requests, [{ deviceKey: 'first' }, { deviceKey: 'first-more' }])
})

test('保存期间失焦，确认最新写入后才移除凭据缓冲', async () => {
  const writing = deferred()
  const controller = createAutosave({ initial: { proxy: '' }, save: async () => {
    await writing.promise
    return { proxy: 'masked' }
  } })
  controller.focus('proxy')
  controller.change('proxy', { proxy: 'private' })
  await settle()
  const blurred = controller.blur('proxy')
  assert.equal(controller.snapshot().form.proxy, 'private')
  writing.resolve()
  await blurred
  assert.equal(controller.snapshot().form.proxy, 'masked')
})

test('输入法组字期间不提交，组合结束后再防抖保存', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { controller, requests } = fixture({ text: '' })
  controller.compose('text', true)
  controller.change('text', { text: '组合中' }, 500)
  t.mock.timers.tick(1000)
  assert.equal(await controller.flush(), false)
  assert.equal(requests.length, 0)
  controller.compose('text', false)
  t.mock.timers.tick(500)
  await settle()
  assert.equal(requests.length, 1)
})

test('补齐连接配置后只重提关联的启用失败', async () => {
  let hasKey = false
  const requests = []
  const controller = createAutosave({ initial: { enabled: false, deviceKey: '' }, save: async patch => {
    requests.push(patch)
    if (patch.enabled && !hasKey) throw new Error('请填写密钥')
    if (patch.deviceKey) hasKey = true
    return { enabled: !!patch.enabled, deviceKey: '' }
  }, onSaved: group => { if (group === 'bark') controller.retry('enabled') } })
  controller.change('enabled', { enabled: true })
  assert.equal(await controller.flush(), false)
  controller.change('bark', { deviceKey: 'filled' })
  assert.equal(await controller.flush(), true)
  assert.deepEqual(requests, [{ enabled: true }, { deviceKey: 'filled' }, { enabled: true }])
})

test('卸载取消延迟提交，已在途请求不再发布状态或继续队列', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = deferred()
  const { controller, requests } = fixture({ enabled: false, proxy: '' }, () => first.promise)
  const updates = []
  controller.subscribe(state => updates.push(state))
  controller.change('enabled', { enabled: true })
  controller.change('proxy', { proxy: 'delayed' }, 500)
  await settle()
  controller.dispose()
  const before = updates.length
  t.mock.timers.tick(1000)
  first.resolve()
  await settle()
  assert.equal(requests.length, 1)
  assert.equal(updates.length, before)
})
