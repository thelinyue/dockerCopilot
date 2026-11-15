import React, { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Monitor, Plus, RefreshCw, Trash2, Pencil, Plug, Save } from 'lucide-react'
import { deviceAPI } from '../api/client.js'
import { cn } from '../utils/cn.js'
import { Dialog, Notice, SettingsPanel, useConfirmation } from './ManagementUI.jsx'

export function DeviceSelector({ deviceId, onChange, compact = false }) {
  const { data: devices = [], error } = useQuery({ queryKey: ['devices'], queryFn: deviceAPI.list })
  const deviceName = deviceId === 'local' ? '本机' : devices.find(device => device.id === deviceId)?.name || '设备不可用'
  return (
    <div>
      <div className={cn('relative rounded-lg', compact ? 'h-11 hover:bg-gray-100 dark:hover:bg-gray-700 focus-within:ring-2 focus-within:ring-primary-500' : '')} title={error?.message || `当前设备：${deviceName}`}>
        <Monitor className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 h-5 w-5', compact ? 'left-1/2 -translate-x-1/2' : 'left-3', error ? 'text-red-500' : 'text-primary-600 dark:text-primary-400')} />
        <select aria-label="当前管理设备" className={cn('input text-sm cursor-pointer', compact ? 'absolute inset-0 h-full opacity-0' : 'pl-10 pr-6')} value={deviceId} onChange={event => onChange(event.target.value)}>
          <option value="local">本机</option>
          {devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
          {deviceId !== 'local' && !devices.some(device => device.id === deviceId) && <option value={deviceId}>设备不可用</option>}
        </select>
      </div>
      {error && !compact && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400 break-words">{error.message}</p>}
    </div>
  )
}

export function Devices({ layout }) {
  const queryClient = useQueryClient()
  const confirm = useConfirmation()
  const { data: devices = [], error, isLoading, isFetching, refetch } = useQuery({ queryKey: ['devices'], queryFn: deviceAPI.list })
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  const [warning, setWarning] = useState('')
  const [formError, setFormError] = useState('')
  const act = async fn => {
    setBusy(true)
    setFailure('')
    setMessage('')
    setWarning('')
    try { await fn() } catch (e) { setFailure(e.message) } finally { setBusy(false) }
  }
  const edit = device => {
    setFormError('')
    setForm(device ? { ...device, secret: '' } : { name: '', address: '', secret: '' })
  }
  const save = async event => {
    event.preventDefault()
    setBusy(true)
    setFormError('')
    try {
      const result = await deviceAPI.save(form)
      setForm(null)
      await queryClient.invalidateQueries({ queryKey: ['devices'] })
      setMessage('设备已保存')
      setFailure('')
      setWarning(result.warning || '')
    } catch (e) { setFormError(e.message) } finally { setBusy(false) }
  }
  const remove = async device => {
    if (!await confirm({ title: '移除设备', message: `从主容器移除 ${device.name}？远端容器和定时任务会继续运行。`, confirmText: '移除', danger: true })) return
    act(async () => {
      await deviceAPI.remove(device.id)
      await queryClient.invalidateQueries({ queryKey: ['devices'] })
      setMessage('设备已移除')
    })
  }
  return (
    <SettingsPanel {...layout} actions={<>
        <button type="button" className="btn-secondary gap-2 disabled:opacity-50" disabled={isFetching || busy} onClick={() => refetch()}><RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />刷新</button>
        <button type="button" className="btn-primary gap-2" onClick={() => edit()}><Plus className="h-4 w-4" />添加设备</button>
      </>}>
      <div className="space-y-4">
        <Notice>{failure || error?.message}</Notice>
        <Notice type="warning" onClose={() => setWarning('')}>{warning}</Notice>
        <Notice type="success" onClose={() => setMessage('')}>{message}</Notice>
        {isLoading ? <div className="card p-6 animate-pulse h-32" /> : devices.length ? (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {devices.map(device => <article key={device.id} className="card rounded-2xl overflow-hidden">
              <div className="p-4 sm:p-6 flex items-center gap-3">
                <div className="p-3 rounded-xl bg-primary-50 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400"><Monitor className="h-6 w-6" /></div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-gray-900 dark:text-white truncate" title={device.name}>{device.name}</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 break-all mt-1">{device.address}</p>
                </div>
              </div>
              <div className="px-4 sm:px-6 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between gap-3">
                <button type="button" className="btn-secondary gap-2 disabled:opacity-50" disabled={busy} onClick={() => act(async () => {
                  const info = await deviceAPI.test(device.id)
                  setMessage(`${device.name} 连接成功 · ${info.version || '开发版'} · 项目组件 ${info.composeVersion || '不可用'}`)
                })}><Plug className="h-4 w-4" />测试连接</button>
                <div className="flex gap-1">
                  <button type="button" aria-label={`编辑 ${device.name}`} title="编辑" className="btn-icon-secondary disabled:opacity-50" disabled={busy} onClick={() => edit(device)}><Pencil className="h-4 w-4" /></button>
                  <button type="button" aria-label={`移除 ${device.name}`} title="移除" className="btn-icon-error disabled:opacity-50" disabled={busy} onClick={() => remove(device)}><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
            </article>)}
          </div>
        ) : !error && <div className="text-center py-12">
          <Monitor className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-3 text-sm font-medium">暂无设备</h3>
          <button type="button" className="btn-primary gap-2 mt-4" onClick={() => edit()}><Plus className="h-4 w-4" />添加设备</button>
        </div>}
      </div>
      {form && <Dialog title={form.id ? '编辑设备' : '添加设备'} onClose={busy ? undefined : () => setForm(null)}>
        <form onSubmit={save}>
          <div className="p-6 space-y-4">
            <Notice>{formError}</Notice>
            <label className="block text-sm font-medium">名称<input data-autofocus required aria-label="设备名称" className="input mt-2" disabled={busy} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
            <label className="block text-sm font-medium">设备地址<input required type="url" aria-label="设备地址" placeholder="http://192.168.1.10:12712" className="input mt-2" disabled={busy} value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} /></label>
            <label className="block text-sm font-medium">登录密钥<input type="password" aria-label="登录密钥" autoComplete="new-password" required={!form.id} placeholder={form.id ? '留空保留原密钥' : ''} className="input mt-2" disabled={busy} value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} /></label>
          </div>
          <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30 flex justify-end gap-3">
            <button type="button" className="btn-secondary disabled:opacity-50" disabled={busy} onClick={() => setForm(null)}>取消</button>
            <button disabled={busy} className="btn-primary gap-2 disabled:opacity-50"><Save className="h-4 w-4" />{busy ? '保存中…' : '保存'}</button>
          </div>
        </form>
      </Dialog>}
    </SettingsPanel>
  )
}
