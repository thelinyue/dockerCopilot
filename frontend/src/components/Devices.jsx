import React, { useEffect, useId, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Monitor, Plus, RefreshCw, Trash2, Pencil, Plug, Save, Check, ChevronDown, Network } from 'lucide-react'
import { deviceAPI } from '../api/client.js'
import { cn } from '../utils/cn.js'
import { Dialog, Notice, SettingsPanel, useConfirmation } from './ManagementUI.jsx'

export function DeviceSelector({ deviceId, onChange, onManageDevices, compact = false, mobile = false }) {
  const { data: devices = [], error, isLoading, isFetching, refetch } = useQuery({ queryKey: ['devices'], queryFn: deviceAPI.list })
  const [open, setOpen] = useState(false)
  const trigger = useRef(null)
  const afterClose = useRef(null)
  const panelId = useId()
  const selected = devices.find(device => device.id === deviceId)
  const deviceName = deviceId === 'local' ? '本机' : selected?.name || (isLoading ? '加载设备…' : '设备不可用')
  const address = deviceId === 'local' ? '当前登录服务' : selected?.address || '请重新选择或管理设备'
  const missing = deviceId !== 'local' && !selected && !isLoading
  const dismiss = action => {
    if (!open) return
    afterClose.current = typeof action === 'function' ? action : null
    setOpen(false)
  }
  useEffect(() => {
    afterClose.current = null
    setOpen(false)
  }, [mobile, compact])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`切换设备，当前设备：${deviceName}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={`当前设备：${deviceName} · ${address}`}
        onClick={() => { setOpen(true); refetch() }}
        className={cn('min-w-0 min-h-[44px] flex items-center text-left transition-colors rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
          mobile ? 'flex-1 px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/50' : compact ? 'w-full justify-center hover:bg-gray-100 dark:hover:bg-gray-700' : 'w-full h-14 gap-3 px-3 border border-gray-200 dark:border-gray-600 hover:border-primary-300 dark:hover:border-primary-600 hover:bg-primary-50/50 dark:hover:bg-primary-900/10')}
      >
        {!mobile && <Monitor aria-hidden="true" className={cn('h-5 w-5 flex-shrink-0', error || missing ? 'text-amber-600 dark:text-amber-400' : 'text-primary-600 dark:text-primary-400')} />}
        {!compact && <div className="min-w-0 flex-1">
          {mobile && <span className="block text-[11px] leading-4 text-gray-500 dark:text-gray-400">Docker Copilot</span>}
          <span className={cn('flex items-center gap-1 text-sm font-semibold', mobile ? 'text-primary-700 dark:text-primary-300' : 'text-gray-900 dark:text-white')}>
            <span className="truncate">{deviceName}</span>
            {mobile && <ChevronDown aria-hidden="true" className="h-4 w-4 flex-shrink-0" />}
          </span>
          {!mobile && <span className="block truncate text-xs text-gray-500 dark:text-gray-400 mt-0.5">{address}</span>}
        </div>}
        {!mobile && !compact && <ChevronDown aria-hidden="true" className="h-4 w-4 flex-shrink-0 text-gray-400" />}
      </button>
      <Dialog id={panelId} title="切换设备" open={open} onClose={() => dismiss()} placement={mobile ? 'sheet' : 'anchored'} anchorRef={trigger} anchorSide={compact ? 'right' : 'bottom'} onExited={() => {
        const action = afterClose.current
        afterClose.current = null
        action?.()
      }}>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-2 space-y-1">
          {error && <div role="alert" className="m-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-sm text-amber-800 dark:text-amber-300">
            <p>无法加载设备列表，请重试。</p>
            <p className="mt-1 text-xs break-words">{error.message}</p>
            <button type="button" className="btn-secondary gap-2 mt-2 min-h-[44px]" disabled={isFetching} onClick={() => refetch()}><RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />重试</button>
          </div>}
          {missing && <p role="status" className="px-3 py-2 text-sm text-amber-700 dark:text-amber-300">当前设备不可用，请选择其他设备或进入设备管理。</p>}
          {[{ id: 'local', name: '本机', address: '当前登录服务' }, ...devices].map(device => {
            const active = device.id === deviceId
            return <button key={device.id} type="button" aria-label={`选择设备：${device.name}`} aria-pressed={active} data-autofocus={active || undefined}
              onClick={() => dismiss(device.id === deviceId ? undefined : () => onChange(device.id))}
              className={cn('w-full min-h-[64px] flex items-center gap-3 px-3 py-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 transition-colors', active ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60')}>
              <Monitor aria-hidden="true" className="h-5 w-5 flex-shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium break-words">{device.name}</span>
                <span className="block truncate text-xs text-gray-500 dark:text-gray-400 mt-0.5" title={device.address}>{device.address}</span>
              </span>
              {active && <Check aria-hidden="true" className="h-5 w-5 flex-shrink-0" />}
            </button>
          })}
          {isLoading && <p role="status" className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">正在加载设备…</p>}
        </div>
        <div className="p-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
          <button type="button" className="btn-secondary w-full min-h-[44px] gap-2" onClick={() => dismiss(onManageDevices)}><Network aria-hidden="true" className="h-4 w-4" />管理设备</button>
        </div>
      </Dialog>
    </>
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
