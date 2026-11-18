import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Bell, Send, KeyRound } from 'lucide-react'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { AutosaveFeedback, AutosaveStatus, Notice, SettingsPanel, Toast } from './ManagementUI.jsx'
import { useSettingsAutosave } from '../hooks/useSettingsAutosave.js'
import { applyNotificationPatch, encodeNotifications, selectNotifications, settingsErrorTarget } from '../utils/settings.js'

const events = [
  ['updateAvailable', '发现镜像更新'],
  ['checkFailed', '检查异常'],
  ['updateSucceeded', '更新成功'],
  ['updateFailed', '更新失败'],
]
const checkbox = 'h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700'

export function Notifications({ layout, onDirty, beforeLeave }) {
  const { deviceId, managementAPI } = useDeviceAPI()
  const { data: info, error: infoError, isLoading: infoLoading } = useQuery({ queryKey: [deviceId, 'nodeInfo'], queryFn: managementAPI.info, retry: false })
  const supported = !!info?.capabilities?.notifications
  const autosave = useSettingsAutosave({ select: selectNotifications, encode: encodeNotifications, apply: applyNotificationPatch, enabled: supported, onDirty, beforeLeave, retryAfter: { bark: ['enabled'] } })
  const { error, isLoading, form } = autosave
  const [busy, setBusy] = useState('')
  const [failure, setFailure] = useState('')
  const [message, setMessage] = useState('')
  const disabled = !!busy || !form || !supported
  const invalid = target => autosave.errors.some(error => settingsErrorTarget(error) === target)
  const change = (key, value) => autosave.change(key, { [key]: value })
  const changeBark = (key, value) => autosave.change('bark', { serverURL: form.serverURL, deviceKey: form.deviceKey, [key]: value }, 500)
  const act = async (action, fn) => {
    setBusy(action)
    setFailure('')
    setMessage('')
    try { await fn() } catch (e) { setFailure(e.message) } finally { setBusy('') }
  }
  const test = () => act('test', async () => {
    const result = await managementAPI.testNotification({ serverURL: form.serverURL, deviceKey: form.deviceKey })
    setMessage(result.message)
  })
  return <SettingsPanel {...layout} status={<AutosaveStatus autosave={autosave} />} menu={[{ label: busy === 'test' ? '测试中…' : '测试推送', icon: Send, disabled, onClick: test }]}>
    <div className="space-y-4">
      <Notice>{infoError?.message || (!form && error?.message)}</Notice>
      <AutosaveFeedback autosave={autosave} fields={['serverURL', 'deviceKey']} />
      <Notice type="warning">{autosave.refreshFailure}</Notice>
      {(infoLoading || isLoading) && <div className="card p-6 animate-pulse h-48" />}
      {info && !supported && <Notice type="warning">当前设备不支持消息推送，请先升级该设备的 DockerCopilot。</Notice>}
      {form && <form id="notification-settings" onSubmit={event => { event.preventDefault(); void autosave.flush() }} className="settings-form space-y-4">
        <section className="settings-section card rounded-2xl overflow-hidden">
          <div className="settings-section-header px-4 sm:px-6 py-2 border-b border-gray-200 dark:border-gray-700">
            <label className="min-h-[44px] flex items-center gap-2 font-semibold cursor-pointer"><Bell aria-hidden="true" className="h-5 w-5 flex-shrink-0 text-primary-600 dark:text-primary-400" /><span className="flex-1">启用消息推送</span><input type="checkbox" className={checkbox} disabled={disabled} checked={form.enabled} onChange={e => change('enabled', e.target.checked)} /></label>
          </div>
          <div role="group" aria-label="通知内容" className="settings-section-body p-4 sm:p-6 grid grid-cols-2 gap-x-3 sm:gap-x-6 gap-y-1">
            {events.map(([key, label]) => <label key={key} className="flex items-center gap-2 sm:gap-3 min-h-[44px] py-2 text-sm cursor-pointer">
              <input type="checkbox" className={`${checkbox} flex-shrink-0`} disabled={disabled || !form.enabled} checked={form[key]} onChange={e => change(key, e.target.checked)} />
              <span>{label}</span>
            </label>)}
          </div>
        </section>
        <section className="settings-section card rounded-2xl overflow-hidden">
          <div className="settings-section-header px-4 sm:px-6 py-2 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-3">
            <h3 className="font-semibold flex items-center gap-2"><KeyRound className="h-5 w-5 text-primary-600 dark:text-primary-400" />Bark</h3>

          </div>
          <div className="settings-section-body notification-fields p-4 sm:p-6 grid md:grid-cols-2 gap-4">
            <div className="notification-field min-w-0">
              <label htmlFor="bark-server" className="block text-sm font-medium">服务器地址</label>
              <input id="bark-server" type="url" required disabled={disabled} aria-invalid={invalid('serverURL') || undefined} aria-describedby={invalid('serverURL') ? 'bark-server-error' : undefined} className={`input min-h-[44px] sm:min-h-0 text-sm ${invalid('serverURL') ? 'border-red-400 dark:border-red-500 focus:ring-red-500' : ''}`} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://api.day.app" value={form.serverURL} {...autosave.inputProps('bark')} onChange={e => changeBark('serverURL', e.target.value)} />
              <AutosaveFeedback autosave={autosave} target="serverURL" id="bark-server-error" />
            </div>
            <div className="notification-field min-w-0">
              <label htmlFor="bark-key" className="flex flex-wrap items-center gap-2 text-sm font-medium">设备密钥{form.hasKey && <span className="text-xs font-normal text-gray-500 dark:text-gray-400">已配置</span>}</label>
              <input id="bark-key" type="password" disabled={disabled} aria-invalid={invalid('deviceKey') || undefined} aria-describedby={invalid('deviceKey') ? 'bark-key-error' : undefined} className={`input min-h-[44px] sm:min-h-0 text-sm ${invalid('deviceKey') ? 'border-red-400 dark:border-red-500 focus:ring-red-500' : ''}`} autoComplete="new-password" autoCapitalize="none" spellCheck={false} placeholder={form.hasKey ? '留空保留原密钥' : '填写 Bark App 中的设备密钥'} value={form.deviceKey} {...autosave.inputProps('bark')} onChange={e => changeBark('deviceKey', e.target.value)} />
              <AutosaveFeedback autosave={autosave} target="deviceKey" id="bark-key-error" />
            </div>
          </div>
          {failure && <div className="px-4 sm:px-6 pb-4"><Notice onClose={() => setFailure('')}>{failure}</Notice></div>}
          <Toast onClose={() => setMessage('')}>{message}</Toast>
        </section>
      </form>}
    </div>
  </SettingsPanel>
}
