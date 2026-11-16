import React, { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Send, Save, KeyRound } from 'lucide-react'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { Notice, SettingsPanel } from './ManagementUI.jsx'
import { notificationPatch } from '../utils/settings.js'

const events = [
  ['updateAvailable', '发现镜像更新'],
  ['checkFailed', '检查异常'],
  ['updateSucceeded', '更新成功'],
  ['updateFailed', '更新失败'],
]
const checkbox = 'h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700'

export function Notifications({ layout, onDirty }) {
  const { deviceId, managementAPI } = useDeviceAPI()
  const queryClient = useQueryClient()
  const { data: info, error: infoError, isLoading: infoLoading } = useQuery({ queryKey: [deviceId, 'nodeInfo'], queryFn: managementAPI.info, retry: false })
  const supported = !!info?.capabilities?.notifications
  const { data, error, isLoading } = useQuery({ queryKey: [deviceId, 'settings'], queryFn: managementAPI.settings, enabled: supported })
  const [draft, setDraft] = useState(null)
  const saved = data?.settings.notifications
  const form = draft || (saved && { ...saved, bark: { ...saved.bark, deviceKey: '' } })
  const patch = saved && form ? notificationPatch(saved, form) : {}
  const dirty = Object.keys(patch).length > 0
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState('')
  const [message, setMessage] = useState('')
  const disabled = !!busy || !form || !supported
  useEffect(() => {
    onDirty(dirty)
    if (!dirty) return
    const stop = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', stop)
    return () => window.removeEventListener('beforeunload', stop)
  }, [dirty, onDirty])
  const change = (key, value) => setDraft(current => ({ ...(current || form), [key]: value }))
  const changeBark = (key, value) => setDraft(current => ({ ...(current || form), bark: { ...(current || form).bark, [key]: value } }))
  const act = async (action, fn) => {
    setBusy(action)
    setFailure('')
    setMessage('')
    try { await fn() } catch (e) { setFailure(e.message) } finally { setBusy('') }
  }
  const save = event => {
    event.preventDefault()
    act('save', async () => {
      await managementAPI.saveSettings({ notifications: patch })
      // 已保存的密钥及时从草稿移除，成功后仅刷新不含密钥的设置响应。
      queryClient.setQueryData([deviceId, 'settings'], current => ({ ...current, settings: { ...current.settings, notifications: { ...form, bark: { serverURL: form.bark.serverURL.trim().replace(/\/+$/, ''), hasKey: !!form.bark.deviceKey.trim() || saved.bark.hasKey } } } }))
      setDraft(null)
      setMessage('设置已保存')
      await queryClient.invalidateQueries({ queryKey: [deviceId, 'settings'] })
    })
  }
  const test = () => act('test', async () => {
    const result = await managementAPI.testNotification({ serverURL: form.bark.serverURL, deviceKey: form.bark.deviceKey })
    setMessage(result.message)
  })
  return <SettingsPanel {...layout} actions={<>
    {dirty && <span className="badge-warning">未保存</span>}
    <button type="button" className="btn-secondary gap-2 disabled:opacity-50" disabled={disabled} onClick={test} title="使用当前填写的连接配置，不保存设置"><Send className="h-4 w-4" />{busy === 'test' ? '测试中…' : '测试推送'}</button>
    <button type="submit" form="notification-settings" className="btn-primary gap-2 disabled:opacity-50" disabled={disabled}><Save className="h-4 w-4" />{busy === 'save' ? '保存中…' : '保存设置'}</button>
  </>}>
    <div className="space-y-4">
      <Notice onClose={failure ? () => setFailure('') : undefined}>{failure || infoError?.message || error?.message}</Notice>
      <Notice type="success" onClose={() => setMessage('')}>{message}</Notice>
      {(infoLoading || isLoading) && <div className="card p-6 animate-pulse h-48" />}
      {info && !supported && <Notice type="warning">当前设备不支持消息推送，请先升级该设备的 DockerCopilot。</Notice>}
      {form && <form id="notification-settings" onSubmit={save} className="space-y-4">
        <section className="card rounded-2xl overflow-hidden">
          <div className="px-4 sm:px-6 py-2 border-b border-gray-200 dark:border-gray-700">
            <label className="min-h-[44px] flex items-center gap-2 font-semibold cursor-pointer"><Bell aria-hidden="true" className="h-5 w-5 flex-shrink-0 text-primary-600 dark:text-primary-400" /><span className="flex-1">启用消息推送</span><input type="checkbox" className={checkbox} disabled={disabled} checked={form.enabled} onChange={e => change('enabled', e.target.checked)} /></label>
          </div>
          <div role="group" aria-label="通知内容" className="p-4 sm:p-6 grid grid-cols-2 gap-x-3 sm:gap-x-6 gap-y-1">
            {events.map(([key, label]) => <label key={key} className="flex items-center gap-2 sm:gap-3 min-h-[44px] py-2 text-sm cursor-pointer">
              <input type="checkbox" className={`${checkbox} flex-shrink-0`} disabled={disabled || !form.enabled} checked={form[key]} onChange={e => change(key, e.target.checked)} />
              <span>{label}</span>
            </label>)}
          </div>
        </section>
        <section className="card rounded-2xl overflow-hidden">
          <div className="px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700"><h3 className="font-semibold flex items-center gap-2"><KeyRound className="h-5 w-5 text-primary-600 dark:text-primary-400" />Bark</h3></div>
          <div className="p-4 sm:p-6 grid md:grid-cols-2 gap-4">
            <div className="space-y-2 min-w-0"><label htmlFor="bark-server" className="block text-sm font-medium">服务器地址</label><input id="bark-server" type="url" required disabled={disabled} className="input min-h-[44px] sm:min-h-0 text-sm" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://api.day.app" value={form.bark.serverURL} onChange={e => changeBark('serverURL', e.target.value)} /></div>
            <div className="space-y-2 min-w-0"><label htmlFor="bark-key" className="flex flex-wrap items-center gap-2 text-sm font-medium">设备密钥{saved.bark.hasKey && <span className="text-xs font-normal text-gray-500 dark:text-gray-400">已配置</span>}</label><input id="bark-key" type="password" disabled={disabled} className="input min-h-[44px] sm:min-h-0 text-sm" autoComplete="new-password" autoCapitalize="none" spellCheck={false} placeholder={saved.bark.hasKey ? '留空保留原密钥' : '填写 Bark App 中的设备密钥'} value={form.bark.deviceKey} onChange={e => changeBark('deviceKey', e.target.value)} /></div>
          </div>
        </section>
      </form>}
    </div>
  </SettingsPanel>
}
