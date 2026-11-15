import React, { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Save, Clock, History, ShieldOff, Network, Play } from 'lucide-react'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { Notice, SettingsPanel, useConfirmation } from './ManagementUI.jsx'
import { ExclusionSelect } from './ExclusionSelect.jsx'
import { TaskHistoryDialog, TaskProgressDialog } from './Tasks.jsx'

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
const selectSettings = data => {
  // 旧节点没有统一计划时间，继续展示双计划，避免只改界面却仍执行两次。
  const unified = data.nextRuns.schedule !== undefined
  const cron = data.settings.autoUpdate ? data.settings.updateCron : data.settings.checkCron
  return {
    ...data,
    unified,
    inheritedSchedule: unified && data.settings.checkCron !== data.settings.updateCron,
    settings: {
      ...data.settings,
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
      const settings = { ...form }
      // 服务端只返回掩码；未编辑的代理字段不提交，保留真正凭据。
      for (const key of ['httpProxy', 'httpsProxy']) if (settings[key] === data.settings[key]) delete settings[key]
      await managementAPI.saveSettings(settings)
      // 写入成功即可结束草稿；后续刷新负责取回代理掩码及下次执行时间。
      queryClient.setQueryData([deviceId, 'settings'], current => ({ ...current, settings: form }))
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
  const excludedContainers = new Set(form?.excludedContainers || [])
  const excludedServices = new Set(form?.excludedServices || [])
  const containersByID = new Map(containers.map(container => [container.id, container]))
  const projectServices = (projectData?.projects || []).flatMap(project => project.services.map(service => ({ value: `${project.id}/${service.name}`, label: `${project.name}/${service.name}`, containers: service.containers })))
  // 用实际容器 ID 关联服务；名称相同的项目不能共享排除状态，也不把继承状态写回设置。
  const servicesByContainer = new Map(projectServices.flatMap(service => service.containers.map(id => [id, service])))
  const containerExcludedServices = new Set(projectServices.filter(service => service.containers.some(id => excludedContainers.has(id) || excludedContainers.has(containersByID.get(id)?.name))).map(service => service.value))
  const containerOptions = containers.map(container => {
    const service = servicesByContainer.get(container.id)
    const directlyExcluded = excludedContainers.has(container.name) || excludedContainers.has(container.id)
    const serviceExcluded = !!service && excludedServices.has(service.value)
    const inherited = serviceExcluded || (!!service && !directlyExcluded && containerExcludedServices.has(service.value))
    const unavailable = !!container.composeProject && !service
    return {
      value: container.name,
      aliases: [container.id],
      label: container.name,
      detail: !container.composeProject ? container.usingImage : `${service?.label || container.composeProject} · ${serviceExcluded ? '已由项目服务排除' : inherited ? '已由同服务容器排除' : unavailable ? '无法确认所属服务，请刷新后再设置' : '排除时同服务副本一起跳过'}`,
      inherited,
      disabled: inherited || (unavailable && !directlyExcluded),
    }
  })
  const serviceOptions = projectServices.map(service => ({
    ...service,
    inherited: containerExcludedServices.has(service.value),
    disabled: containerExcludedServices.has(service.value),
    detail: containerExcludedServices.has(service.value) ? '已由容器排除，请在容器栏移除对应规则' : '仅排除此服务，不影响项目中的其他服务',
  }))
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
            <div className="px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex flex-wrap justify-between items-center gap-2">
              <h3 className="font-semibold flex items-center gap-2"><Clock className="h-5 w-5 text-primary-600 dark:text-primary-400" />定时计划</h3>
              <span className="text-xs text-gray-500 dark:text-gray-400">{data.nextRuns.timezone}</span>
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
                {!data.unified && <p className="text-xs text-gray-500 dark:text-gray-400">下次{dirty ? '（已保存计划）' : ''} · {date(key === 'checkCron' ? data.nextRuns.check : data.nextRuns.update)}</p>}
              </div>)}
              {data.unified && <div className="flex items-center justify-between gap-2 md:block md:space-y-2 min-w-0">
                <p className="text-sm font-medium">下次执行{dirty && <span className="block md:inline md:ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">已保存计划</span>}</p>
                <p className="md:min-h-[38px] flex items-center text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">{date(data.nextRuns.schedule)}</p>
              </div>}
              {data.unified && <div className="md:col-span-2 space-y-1 min-w-0">
                <div className="flex flex-col sm:flex-row sm:flex-wrap sm:gap-x-8">
                  <label className="min-h-[44px] flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" className={checkbox} disabled={busy} checked={form.autoUpdate} onChange={e => change('autoUpdate', e.target.checked)} />发现更新后自动更新</label>
                  <label className="min-h-[44px] flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" className={checkbox} disabled={busy} checked={form.startupCheck} onChange={e => change('startupCheck', e.target.checked)} />启动时仅检测</label>
                </div>
              </div>}
            </div>
            <div className="px-4 sm:px-6 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30 flex flex-wrap items-center gap-2">
              <button type="button" className="btn-secondary gap-2 disabled:opacity-50" disabled={busy} onClick={() => run('立即检测', managementAPI.check)}><RefreshCw className="h-4 w-4" />立即检测</button>
              <button type="button" className="btn-secondary gap-2 disabled:opacity-50" disabled={busy} onClick={update}><Play className="h-4 w-4" />检测并更新</button>
              {task && <button type="button" className="min-h-[44px] sm:min-h-0 text-xs text-primary-600 dark:text-primary-400 hover:underline ml-auto" onClick={() => setProgressOpen(true)}>查看进度</button>}
              {dirty && <span className="text-xs text-gray-500 dark:text-gray-400">使用已保存设置</span>}
            </div>
          </section>
          <section className="card rounded-2xl">
            <div className="px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700"><h3 className="font-semibold flex items-center gap-2"><ShieldOff className="h-5 w-5 text-primary-600 dark:text-primary-400" />自动更新排除项</h3></div>
            <div className="p-4 sm:p-6 grid md:grid-cols-2 gap-4">
              <ExclusionSelect label="容器" options={containerOptions} value={form.excludedContainers || []} onChange={value => change('excludedContainers', value)} disabled={busy} loading={containersLoading} error={containerError} />
              <ExclusionSelect label="项目服务" options={serviceOptions} value={form.excludedServices || []} onChange={value => change('excludedServices', value)} disabled={busy} loading={projectsLoading} error={projectError} />
            </div>
          </section>
          <section className="card rounded-2xl overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700"><h3 className="font-semibold flex items-center gap-2"><Network className="h-5 w-5 text-primary-600 dark:text-primary-400" />检测代理</h3></div>
            <div className="p-4 sm:p-6 space-y-3">
              <div className="grid md:grid-cols-2 gap-4">{[['httpProxy', 'HTTP_PROXY'], ['httpsProxy', 'HTTPS_PROXY']].map(([key, label]) => <label key={key} className="text-sm font-medium">{label}<input disabled={busy} autoComplete="off" type="text" aria-label={label} className="input min-h-[44px] sm:min-h-0 mt-2 text-sm" placeholder="直连" value={form[key]} onChange={e => change(key, e.target.value)} /></label>)}</div>
            </div>
          </section>
        </form>}
      </div>
      {historyOpen && <TaskHistoryDialog onClose={() => setHistoryOpen(false)} />}
      {task && <TaskProgressDialog task={task} open={progressOpen} onClose={() => setProgressOpen(false)} />}
    </SettingsPanel>
  )
}
