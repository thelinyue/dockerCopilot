import React, { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Save, Clock, History, ShieldOff, Network, Play } from 'lucide-react'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { Notice, SettingsPanel, useConfirmation } from './ManagementUI.jsx'
import { ExclusionSelect } from './ExclusionSelect.jsx'
import { TaskHistoryDialog, TaskProgressDialog } from './Tasks.jsx'
import { getExclusionOptions, changeExclusion } from '../utils/exclusions.js'
import { automationFields, changedFields } from '../utils/settings.js'

const frequencies = [
  ['30 * * * *', '每小时第 30 分钟'],
  ['0 */6 * * *', '每 6 小时'],
  ['0 3 * * *', '每天 03:00'],
  ['0 3 * * 0', '每周日 03:00'],
]
const isCustom = value => !frequencies.some(([cron]) => cron === value)
// 调度时间由设备按自身时区返回，保留其墙上时间，不转换为浏览器时区。
const date = value => value && !value.startsWith('0001') ? value.slice(0, 16).replace('T', ' ') : '未启用'
const checkbox = 'h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700'
const actionButton = 'inline-flex items-center justify-center gap-2 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 px-2 sm:px-3 py-2 text-sm font-medium whitespace-nowrap rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm hover:shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed'
const selectSettings = data => {
  // 旧节点没有统一计划时间，继续展示双计划，避免只改界面却仍执行两次。
  const unified = data.nextRuns.schedule !== undefined
  const cron = data.settings.autoUpdate ? data.settings.updateCron : data.settings.checkCron
  return {
    ...data,
    unified,
    inheritedSchedule: unified && data.settings.checkCron !== data.settings.updateCron,
    settings: {
      ...Object.fromEntries(automationFields.map(key => [key, data.settings[key]])),
      ...(unified ? { checkCron: cron, updateCron: cron } : {}),
      excludedContainers: [...new Set((data.settings.excludedContainers || []).map(value => value.trim()).filter(Boolean))],
      excludedServices: [...new Set((data.settings.excludedServices || []).map(value => value.trim()).filter(Boolean))],
    },
  }
}

export function Automation({ layout, onDirty }) {
  const { deviceId, managementAPI, containerAPI } = useDeviceAPI()
  const queryClient = useQueryClient()
  const confirm = useConfirmation()
  const { data, error, isLoading } = useQuery({ queryKey: [deviceId, 'settings'], queryFn: managementAPI.settings, select: selectSettings })
  const { data: projectData, error: projectError, isLoading: projectsLoading } = useQuery({ queryKey: [deviceId, 'composeProjects'], queryFn: managementAPI.projects, retry: false })
  const { data: containers = [], error: containerError, isLoading: containersLoading } = useQuery({ queryKey: [deviceId, 'containers'], queryFn: async () => (await containerAPI.getContainers()).data.data || [], retry: false })
  // 草稿独立于查询缓存，后台刷新不能覆盖尚未保存的输入。
  const [draft, setDraft] = useState(null)
  const form = draft || data?.settings
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(data?.settings)
  const [custom, setCustom] = useState({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [task, setTask] = useState(null)
  const [progressOpen, setProgressOpen] = useState(false)
  useEffect(() => {
    onDirty(dirty)
    if (!dirty) return
    const stop = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', stop)
    return () => window.removeEventListener('beforeunload', stop)
  }, [dirty, onDirty])
  const change = (name, value) => setDraft(current => ({
    ...(current || form), [name]: value,
    ...(data.unified && (name === 'checkCron' || name === 'updateCron') ? { checkCron: value, updateCron: value } : {}),
  }))
  const act = async fn => {
    setBusy(true)
    setFailure('')
    setMessage('')
    try { await fn(); await queryClient.invalidateQueries({ queryKey: [deviceId, 'tasks'] }) } catch (e) { setFailure(e.message) } finally { setBusy(false) }
  }
  const save = event => {
    event.preventDefault()
    act(async () => {
      const settings = changedFields(data.settings, form, automationFields)
      // 未改动的掩码不回传；编辑认证地址后必须重新填写密码，不能把掩码存成新密码。
      for (const key of ['httpProxy', 'httpsProxy']) {
        if (!(key in settings)) continue
        else {
          let password = ''
          try { password = decodeURIComponent(new URL(settings[key]).password) } catch { /* 无效地址由服务端统一校验。 */ }
          if (password === '********') throw new Error('代理地址包含密码掩码，修改代理时请重新填写完整地址和密码。')
        }
      }
      await managementAPI.saveSettings(settings)
      // 写入成功即可结束草稿；后续刷新负责取回代理掩码及下次执行时间。
      queryClient.setQueryData([deviceId, 'settings'], current => ({ ...current, settings: { ...current.settings, ...settings } }))
      setDraft(null)
      await queryClient.invalidateQueries({ queryKey: [deviceId, 'settings'] })
      setMessage('设置已保存')
    })
  }
  const update = async () => {
    if (!await confirm({ title: '检测并更新', message: '立即检测更新，并按已保存的排除规则更新符合条件的容器和项目服务。项目服务已保存但未部署的配置也会应用。', confirmText: '开始检测并更新' })) return
    run('检测并更新', managementAPI.autoUpdate)
  }
  const run = (title, submit) => act(async () => {
    const result = await submit()
    setTask({ taskID: result.taskID, title })
    setProgressOpen(true)
  })
  const exclusionOptions = getExclusionOptions(form || {}, containers, projectData?.projects || [])
  const setExclusion = (option, selected) => setDraft(current => {
    const settings = current || form
    return { ...settings, ...changeExclusion(settings, option, selected) }
  })
  return (
    <SettingsPanel {...layout} actions={<>
        {dirty && <span className="badge-warning">未保存</span>}
        <button type="button" className="btn-secondary gap-2" onClick={() => setHistoryOpen(true)}><History className="h-4 w-4" />执行记录</button>
        <button type="submit" form="automation-settings" className="btn-primary gap-2 disabled:opacity-50" disabled={busy || !form}><Save className="h-4 w-4" />{busy ? '处理中…' : '保存设置'}</button>
      </>}>
      <div className="space-y-4">
        <Notice onClose={failure ? () => setFailure('') : undefined}>{failure || error?.message}</Notice>
        <Notice type="success" onClose={() => setMessage('')}>{message}</Notice>
        {isLoading && <div className="card p-6 animate-pulse h-48" />}
        {form && <form id="automation-settings" onSubmit={save} className="space-y-4">
          <section className="card rounded-2xl overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center gap-1 sm:gap-3">
              <h3 className="font-semibold flex items-center gap-2 whitespace-nowrap"><Clock className="h-5 w-5 text-primary-600 dark:text-primary-400" />定时计划</h3>
              <div role="group" aria-label="立即执行" className="flex items-center gap-1 sm:gap-2">
                {task && <button type="button" aria-label="查看进度" title="查看进度" className="btn-icon-secondary flex-shrink-0" onClick={() => setProgressOpen(true)}><History className="h-4 w-4" /></button>}
                <button type="button" aria-label="立即检测" title="立即检测（使用已保存设置）" className={`${actionButton} text-primary-600 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/20 hover:border-primary-200 dark:hover:border-primary-800`} disabled={busy} onClick={() => run('立即检测', managementAPI.check)}><RefreshCw className="h-4 w-4 flex-shrink-0" /><span className="hidden sm:inline">立即检测</span></button>
                <button type="button" aria-label="检测并更新" title="检测并更新（使用已保存设置）" className={`${actionButton} text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:border-purple-200 dark:hover:border-purple-800`} disabled={busy} onClick={update}><Play className="h-4 w-4 flex-shrink-0" /><span className="hidden sm:inline">检测并更新</span></button>
              </div>
            </div>
            {!data.unified && <p className="px-4 sm:px-6 pt-4 text-xs text-gray-500 dark:text-gray-400">旧版设备使用双计划，升级后可合并。</p>}
            {data.inheritedSchedule && <p className="px-4 sm:px-6 pt-4 text-xs text-gray-500 dark:text-gray-400">已沿用原{data.settings.autoUpdate ? '自动更新' : '检测'}频率</p>}
            <div className="p-4 sm:px-6 grid md:grid-cols-2 gap-x-6 gap-y-3">
              {(data.unified ? [['checkCron', '执行频率']] : [['checkCron', '检测计划'], ['updateCron', '自动更新计划']]).map(([key, label]) => <div key={key} className="space-y-2 min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label htmlFor={key} className="text-sm font-medium">{label}</label>
                  {!data.unified && <label className="flex items-center gap-2 min-h-[44px] text-sm">
                    <input type="checkbox" disabled={busy} className={checkbox} checked={key === 'checkCron' ? form.startupCheck : form.autoUpdate} onChange={e => change(key === 'checkCron' ? 'startupCheck' : 'autoUpdate', e.target.checked)} />{key === 'checkCron' ? '启动时检测' : '开启自动更新'}
                  </label>}
                </div>
                <select id={key} disabled={busy} aria-label={`${label}常用频率`} className="input min-h-[44px] sm:min-h-0 text-sm" value={(custom[key] ?? isCustom(form[key])) ? 'custom' : form[key]} onChange={e => {
                  setCustom(current => ({ ...current, [key]: e.target.value === 'custom' }))
                  if (e.target.value !== 'custom') change(key, e.target.value)
                }}>
                  {frequencies.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                  <option value="custom">自定义 Cron</option>
                </select>
                {(custom[key] ?? isCustom(form[key])) && <input required disabled={busy} className="input min-h-[44px] sm:min-h-0 text-sm font-mono" aria-label={`${label} Cron`} placeholder="分 时 日 月 周" value={form[key]} onChange={e => change(key, e.target.value)} />}
                {!data.unified && <p className="text-xs text-gray-500 dark:text-gray-400">下次{dirty ? '（已保存计划）' : ''} · {date(key === 'checkCron' ? data.nextRuns.check : data.nextRuns.update)}<span className="ml-2">{data.nextRuns.timezone}</span></p>}
              </div>)}
              {data.unified && <div className="flex flex-wrap items-center gap-x-2 gap-y-1 md:self-end md:min-h-[38px] text-xs min-w-0">
                <span className="text-gray-500 dark:text-gray-400">下次执行</span>
                <span className="text-sm font-medium tabular-nums text-gray-700 dark:text-gray-200 whitespace-nowrap">{date(data.nextRuns.schedule)}</span>
                <span className="text-gray-500 dark:text-gray-400">· {data.nextRuns.timezone}</span>
                {dirty && <span className="text-gray-500 dark:text-gray-400">（已保存计划）</span>}
              </div>}
              {data.unified && <div className="md:col-span-2 space-y-1 min-w-0">
                <div className="flex flex-col sm:flex-row sm:flex-wrap sm:gap-x-8">
                  <label className="min-h-[44px] flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" className={checkbox} disabled={busy} checked={form.autoUpdate} onChange={e => change('autoUpdate', e.target.checked)} />发现更新后自动更新</label>
                  <label className="min-h-[44px] flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" className={checkbox} disabled={busy} checked={form.startupCheck} onChange={e => change('startupCheck', e.target.checked)} />启动时仅检测</label>
                </div>
              </div>}
            </div>
          </section>
          <section className="card rounded-2xl">
            <div className="px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700"><h3 className="font-semibold flex items-center gap-2"><ShieldOff className="h-5 w-5 text-primary-600 dark:text-primary-400" />自动更新排除项</h3></div>
            <div className="p-4 sm:p-6">
              <ExclusionSelect label="排除容器" options={exclusionOptions} onChange={setExclusion} disabled={busy} loading={containersLoading || projectsLoading} error={containerError || projectError} />
            </div>
          </section>
          <section className="card rounded-2xl overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700"><h3 className="font-semibold flex items-center gap-2"><Network className="h-5 w-5 text-primary-600 dark:text-primary-400" />检测代理</h3></div>
            <div className="px-4 sm:px-6 py-4 grid sm:grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-2">
              <label htmlFor="registry-proxy" className="block sm:flex sm:items-center sm:min-h-[38px] text-sm font-medium">代理地址</label>
              <div className="min-w-0 space-y-2">
                <input id="registry-proxy" disabled={busy} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} type="text" inputMode="url" aria-describedby="registry-proxy-help" className="input min-h-[44px] sm:min-h-0 text-sm font-mono" placeholder="http://proxy.example:7890" value={form.httpsProxy || form.httpProxy || ''} onChange={event => {
                  const value = event.target.value
                  setDraft(current => ({ ...(current || form), httpProxy: value, httpsProxy: value }))
                }} />
                <p id="registry-proxy-help" className="text-xs text-gray-500 dark:text-gray-400">留空直连，保存后生效。</p>
                {form.httpProxy !== form.httpsProxy && <p className="text-xs text-amber-600 dark:text-amber-400">原代理配置不同，当前显示 {form.httpsProxy ? 'HTTPS' : 'HTTP'} 代理；修改后将统一。</p>}
              </div>
            </div>
          </section>
        </form>}
      </div>
      {historyOpen && <TaskHistoryDialog onClose={() => setHistoryOpen(false)} />}
      {task && <TaskProgressDialog task={task} open={progressOpen} onClose={() => setProgressOpen(false)} />}
    </SettingsPanel>
  )
}
