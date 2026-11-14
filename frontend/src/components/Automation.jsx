import React, { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Save, Clock, History, ShieldOff, Network, Play } from 'lucide-react'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { Notice, PageHeader, useConfirmation } from './ManagementUI.jsx'
import { ExclusionSelect } from './ExclusionSelect.jsx'
import { TaskHistoryDialog, TaskProgressDialog } from './Tasks.jsx'

const frequencies = [
  ['30 * * * *', '每小时第 30 分钟'],
  ['0 */6 * * *', '每 6 小时'],
  ['0 3 * * *', '每天 03:00'],
  ['0 3 * * 0', '每周日 03:00'],
]
const isCustom = value => !frequencies.some(([cron]) => cron === value)
const date = value => value && !value.startsWith('0001') ? new Date(value).toLocaleString() : '未启用'
const checkbox = 'h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700'

export function Automation() {
  const { deviceId, managementAPI, containerAPI } = useDeviceAPI()
  const queryClient = useQueryClient()
  const confirm = useConfirmation()
  const { data, error, isLoading } = useQuery({ queryKey: [deviceId, 'settings'], queryFn: managementAPI.settings })
  const { data: projectData, error: projectError, isLoading: projectsLoading } = useQuery({ queryKey: [deviceId, 'composeProjects'], queryFn: managementAPI.projects, retry: false })
  const { data: containers = [], error: containerError, isLoading: containersLoading } = useQuery({ queryKey: [deviceId, 'containers'], queryFn: async () => (await containerAPI.getContainers()).data.data || [], retry: false })
  const [form, setForm] = useState(null)
  const [custom, setCustom] = useState({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [task, setTask] = useState(null)
  const [progressOpen, setProgressOpen] = useState(false)
  useEffect(() => {
    if (data) {
      setForm({
        ...data.settings,
        excludedContainers: [...new Set((data.settings.excludedContainers || []).map(value => value.trim()).filter(Boolean))],
        excludedServices: [...new Set((data.settings.excludedServices || []).map(value => value.trim()).filter(Boolean))],
      })
      setCustom({ checkCron: isCustom(data.settings.checkCron), updateCron: isCustom(data.settings.updateCron) })
    }
  }, [data])
  const change = (name, value) => setForm(current => ({ ...current, [name]: value }))
  const act = async fn => {
    setBusy(true)
    setFailure('')
    setMessage('')
    try { await fn(); await queryClient.invalidateQueries({ queryKey: [deviceId, 'tasks'] }) } catch (e) { setFailure(e.message) } finally { setBusy(false) }
  }
  const save = event => {
    event.preventDefault()
    act(async () => {
      const settings = { ...form }
      // 服务端只返回掩码；未编辑的代理字段不提交，保留真正凭据。
      for (const key of ['httpProxy', 'httpsProxy']) if (settings[key] === data.settings[key]) delete settings[key]
      await managementAPI.saveSettings(settings)
      await queryClient.invalidateQueries({ queryKey: [deviceId, 'settings'] })
      setMessage('设置已保存')
    })
  }
  const update = async () => {
    if (!await confirm({ title: '立即更新', message: '按已保存的排除规则更新容器。项目服务已保存但未部署的配置也会应用。', confirmText: '开始更新' })) return
    run('立即更新', managementAPI.autoUpdate)
  }
  const run = (title, submit) => act(async () => {
    const result = await submit()
    setTask({ taskID: result.taskID, title })
    setProgressOpen(true)
  })
  const containerOptions = containers.map(container => ({ value: container.name, aliases: [container.id], label: container.name, detail: container.usingImage }))
  const serviceOptions = (projectData?.projects || []).flatMap(project => project.services.map(service => ({ value: `${project.id}/${service.name}`, label: `${project.name}/${service.name}` })))
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 text-gray-900 dark:text-gray-100">
      <PageHeader title="自动更新">
        <button type="button" className="btn-secondary gap-2" onClick={() => setHistoryOpen(true)}><History className="h-4 w-4" />执行记录</button>
        <button type="submit" form="automation-settings" className="btn-primary gap-2 disabled:opacity-50" disabled={busy || !form}><Save className="h-4 w-4" />{busy ? '处理中…' : '保存设置'}</button>
      </PageHeader>
      <div className="space-y-4">
        <Notice onClose={failure ? () => setFailure('') : undefined}>{failure || error?.message}</Notice>
        <Notice type="success" onClose={() => setMessage('')}>{message}</Notice>
        {isLoading && <div className="card p-6 animate-pulse h-48" />}
        {form && <form id="automation-settings" onSubmit={save} className="space-y-4">
          <section className="card rounded-2xl overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex flex-wrap justify-between items-center gap-2">
              <h3 className="font-semibold flex items-center gap-2"><Clock className="h-5 w-5 text-primary-600 dark:text-primary-400" />定时计划</h3>
              <span className="text-xs text-gray-500 dark:text-gray-400">{data.nextRuns.timezone}</span>
            </div>
            <div className="p-4 sm:p-6 grid md:grid-cols-2 gap-6">
              {[['checkCron', '检测计划'], ['updateCron', '自动更新计划']].map(([key, label]) => <div key={key} className="space-y-3 min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label htmlFor={key} className="text-sm font-medium">{label}</label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" disabled={busy} className={checkbox} checked={key === 'checkCron' ? form.startupCheck : form.autoUpdate} onChange={e => change(key === 'checkCron' ? 'startupCheck' : 'autoUpdate', e.target.checked)} />{key === 'checkCron' ? '启动时检测' : '开启自动更新'}
                  </label>
                </div>
                <select id={key} disabled={busy} aria-label={`${label}常用频率`} className="input text-sm" value={custom[key] ? 'custom' : form[key]} onChange={e => {
                  setCustom(current => ({ ...current, [key]: e.target.value === 'custom' }))
                  if (e.target.value !== 'custom') change(key, e.target.value)
                }}>
                  {frequencies.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                  <option value="custom">自定义 Cron</option>
                </select>
                {custom[key] && <input required disabled={busy} className="input text-sm font-mono" aria-label={`${label} Cron`} placeholder="分 时 日 月 周" value={form[key]} onChange={e => change(key, e.target.value)} />}
                <p className="text-xs text-gray-500 dark:text-gray-400" title="已保存计划的下次执行时间">下次 · {date(key === 'checkCron' ? data.nextRuns.check : data.nextRuns.update)}</p>
              </div>)}
            </div>
            <div className="px-4 sm:px-6 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30 flex flex-wrap items-center gap-2">
              <button type="button" className="btn-secondary gap-2 disabled:opacity-50" disabled={busy} onClick={() => run('立即检测', managementAPI.check)}><RefreshCw className="h-4 w-4" />立即检测</button>
              <button type="button" className="btn-secondary gap-2 disabled:opacity-50" disabled={busy} onClick={update}><Play className="h-4 w-4" />立即更新</button>
              {task && <button type="button" className="text-xs text-primary-600 dark:text-primary-400 hover:underline ml-auto" onClick={() => setProgressOpen(true)}>查看进度</button>}
            </div>
          </section>
          <section className="card rounded-2xl">
            <div className="px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700"><h3 className="font-semibold flex items-center gap-2"><ShieldOff className="h-5 w-5 text-primary-600 dark:text-primary-400" />排除项</h3></div>
            <div className="p-4 sm:p-6 grid md:grid-cols-2 gap-4">
              <ExclusionSelect label="容器" options={containerOptions} value={form.excludedContainers || []} onChange={value => change('excludedContainers', value)} disabled={busy} loading={containersLoading} error={containerError} />
              <ExclusionSelect label="项目服务" options={serviceOptions} value={form.excludedServices || []} onChange={value => change('excludedServices', value)} disabled={busy} loading={projectsLoading} error={projectError} />
            </div>
          </section>
          <section className="card rounded-2xl overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700"><h3 className="font-semibold flex items-center gap-2"><Network className="h-5 w-5 text-primary-600 dark:text-primary-400" />检测代理</h3></div>
            <div className="p-4 sm:p-6 space-y-3">
              <div className="grid md:grid-cols-2 gap-4">{[['httpProxy', 'HTTP_PROXY'], ['httpsProxy', 'HTTPS_PROXY']].map(([key, label]) => <label key={key} className="text-sm font-medium">{label}<input disabled={busy} autoComplete="off" type="password" aria-label={label} className="input mt-2 text-sm" placeholder="直连" value={form[key]} onChange={e => change(key, e.target.value)} /></label>)}</div>
              <p className="text-xs text-gray-500 dark:text-gray-400">仅用于更新检测；镜像拉取代理在宿主机设置。</p>
            </div>
          </section>
        </form>}
      </div>
      {historyOpen && <TaskHistoryDialog onClose={() => setHistoryOpen(false)} />}
      {task && <TaskProgressDialog task={task} open={progressOpen} onClose={() => setProgressOpen(false)} />}
    </div>
  )
}
