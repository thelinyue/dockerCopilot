import React, { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Clock, History, ShieldOff, Network, Play, Archive } from 'lucide-react'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { AutosaveFeedback, AutosaveStatus, Notice, SettingsPanel, useConfirmation } from './ManagementUI.jsx'
import { useSettingsAutosave } from '../hooks/useSettingsAutosave.js'
import { ExclusionSelect } from './ExclusionSelect.jsx'
import { TaskHistoryDialog, TaskProgressDialog } from './Tasks.jsx'
import { getExclusionOptions, changeExclusion } from '../utils/exclusions.js'
import { automationFields, applyAutomationPatch, settingsErrorTarget, validateProxyPatch } from '../utils/settings.js'

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
      ...Object.fromEntries(automationFields.map(key => [key, data.settings[key]])),
      ...(unified ? { checkCron: cron, updateCron: cron } : {}),
      excludedContainers: [...new Set((data.settings.excludedContainers || []).map(value => value.trim()).filter(Boolean))],
      excludedServices: [...new Set((data.settings.excludedServices || []).map(value => value.trim()).filter(Boolean))],
    },
  }
}

export function Automation({ layout, onDirty, beforeLeave }) {
  const { deviceId, managementAPI, containerAPI } = useDeviceAPI()
  const queryClient = useQueryClient()
  const confirm = useConfirmation()
  const autosave = useSettingsAutosave({
    select: selectSettings, encode: validateProxyPatch, apply: applyAutomationPatch, onDirty, beforeLeave,
    onSaved: group => { if (group === 'proxy' || group === 'githubProxy') void queryClient.invalidateQueries({ queryKey: [deviceId, 'version'] }) },
  })
  const { data, error, isLoading, form, dirty } = autosave
  const { data: projectData, error: projectError, isLoading: projectsLoading } = useQuery({ queryKey: [deviceId, 'composeProjects'], queryFn: managementAPI.projects, retry: false })
  const { data: containers = [], error: containerError, isLoading: containersLoading } = useQuery({ queryKey: [deviceId, 'containers'], queryFn: async () => (await containerAPI.getContainers()).data.data || [], retry: false })
  const [custom, setCustom] = useState({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [task, setTask] = useState(null)
  const [progressOpen, setProgressOpen] = useState(false)
  const invalid = target => autosave.errors.some(error => settingsErrorTarget(error) === target)
  const change = (name, value, delay = 0) => autosave.change(data.unified && (name === 'checkCron' || name === 'updateCron') ? 'schedule' : name, {
    [name]: value,
    ...(data.unified && (name === 'checkCron' || name === 'updateCron') ? { checkCron: value, updateCron: value } : {}),
  }, delay)
  const act = async fn => {
    setBusy(true)
    setFailure('')
    try { await fn(); await queryClient.invalidateQueries({ queryKey: [deviceId, 'tasks'] }) } catch (e) { setFailure(e.message) } finally { setBusy(false) }
  }
  const update = async () => {
    if (!await confirm({ title: '检测并更新', message: '立即检测更新，并按已保存的排除规则更新符合条件的容器和项目服务。项目服务已保存但未部署的配置也会应用。', confirmText: '开始检测并更新' })) return
    run('检测并更新', managementAPI.autoUpdate)
  }
  const run = (title, submit) => act(async () => {
    if (!await autosave.flush()) throw new Error('部分设置尚未生效，请修正输入或重试保存后再执行。')
    const result = await submit()
    setTask({ taskID: result.taskID, title })
    setProgressOpen(true)
  })
  const exclusionOptions = getExclusionOptions(form || {}, containers, projectData?.projects || [])
  const setExclusion = (option, selected) => autosave.change('exclusions', changeExclusion(form, option, selected))
  return (
    <SettingsPanel {...layout} status={<AutosaveStatus autosave={autosave} />} menu={[
      { label: '立即检测', icon: RefreshCw, disabled: busy || !form, onClick: () => run('立即检测', managementAPI.check) },
      { label: '检测并更新', icon: Play, disabled: busy || !form, onClick: update },
      task && { label: '查看进度', icon: Clock, onClick: () => setProgressOpen(true) },
      { label: '执行记录', icon: History, onClick: () => setHistoryOpen(true) },
    ].filter(Boolean)}>
      <div className="space-y-4">
        <Notice onClose={failure ? () => setFailure('') : undefined}>{failure || (!form && error?.message)}</Notice>
        <AutosaveFeedback autosave={autosave} fields={data?.unified ? ['schedule', 'proxy', 'githubProxy'] : ['checkCron', 'updateCron', 'proxy', 'githubProxy']} />
        <Notice type="warning">{autosave.refreshFailure}</Notice>
        {isLoading && <div className="card p-6 animate-pulse h-48" />}
        {form && <form id="automation-settings" onSubmit={event => { event.preventDefault(); void autosave.flush() }} className="settings-form space-y-4">
          <section className="settings-section card rounded-2xl overflow-hidden">
            <div className="settings-section-header px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center gap-1 sm:gap-3">
              <h3 className="font-semibold flex items-center gap-2 whitespace-nowrap"><Clock className="h-5 w-5 text-primary-600 dark:text-primary-400" />定时计划</h3>

            </div>
            {!data.unified && <p className="px-4 sm:px-6 pt-4 text-xs text-gray-500 dark:text-gray-400">旧版设备使用双计划，升级后可合并。</p>}
            {data.inheritedSchedule && <p className="px-4 sm:px-6 pt-4 text-xs text-gray-500 dark:text-gray-400">已沿用原{data.settings.autoUpdate ? '自动更新' : '检测'}频率</p>}
            <div className="settings-section-body schedule-body p-4 sm:px-6 grid md:grid-cols-2 gap-x-6 gap-y-3">
              {(data.unified ? [['checkCron', '执行频率']] : [['checkCron', '检测计划'], ['updateCron', '自动更新计划']]).map(([key, label]) => <div key={key} className="space-y-2 min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label htmlFor={key} className="text-sm font-medium">{label}</label>
                  {!data.unified && <label className="flex items-center gap-2 min-h-[44px] text-sm">
                    <input type="checkbox" disabled={busy} className={checkbox} checked={key === 'checkCron' ? form.startupCheck : form.autoUpdate} onChange={e => change(key === 'checkCron' ? 'startupCheck' : 'autoUpdate', e.target.checked)} />{key === 'checkCron' ? '启动时检测' : '开启自动更新'}
                  </label>}
                </div>
                <select id={key} disabled={busy} aria-label={`${label}常用频率`} aria-invalid={invalid(data.unified ? 'schedule' : key) || undefined} aria-describedby={invalid(data.unified ? 'schedule' : key) ? `${key}-error` : undefined} className="input min-h-[44px] sm:min-h-0 text-sm" value={(custom[key] ?? isCustom(form[key])) ? 'custom' : form[key]} onChange={e => {
                  setCustom(current => ({ ...current, [key]: e.target.value === 'custom' }))
                  if (e.target.value !== 'custom') change(key, e.target.value)
                }}>
                  {frequencies.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                  <option value="custom">自定义 Cron</option>
                </select>
                {(custom[key] ?? isCustom(form[key])) && <input required disabled={busy} className={`input min-h-[44px] sm:min-h-0 text-sm font-mono ${invalid(data.unified ? 'schedule' : key) ? 'border-red-400 dark:border-red-500 focus:ring-red-500' : ''}`} aria-label={`${label} Cron`} aria-invalid={invalid(data.unified ? 'schedule' : key) || undefined} aria-describedby={invalid(data.unified ? 'schedule' : key) ? `${key}-error` : undefined} placeholder="分 时 日 月 周" value={form[key]} {...autosave.inputProps(data.unified ? 'schedule' : key)} onChange={e => change(key, e.target.value, 500)} />}
                <AutosaveFeedback autosave={autosave} target={data.unified ? 'schedule' : key} id={`${key}-error`} />
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
          <section className="settings-section card rounded-2xl">
            <div className="settings-section-header px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700"><h3 className="font-semibold flex items-center gap-2"><ShieldOff className="h-5 w-5 text-primary-600 dark:text-primary-400" />自动更新排除项</h3></div>
            <div className="settings-section-body p-4 sm:p-6">
              <ExclusionSelect label="排除容器" options={exclusionOptions} onChange={setExclusion} disabled={busy} loading={containersLoading || projectsLoading} error={containerError || projectError} />
            </div>
          </section>
          <section className="settings-section retention-section card rounded-2xl overflow-hidden">
            <div className="settings-section-header px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700"><h3 className="font-semibold flex items-center gap-2"><Archive className="h-5 w-5 text-primary-600 dark:text-primary-400" />独立容器更新</h3></div>
            <div className="settings-section-body px-4 sm:px-6 py-4 space-y-2">
              <label className="min-h-[44px] flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" className={checkbox} disabled={busy || typeof form.keepOldContainer !== 'boolean'} checked={form.keepOldContainer ?? false} onChange={event => change('keepOldContainer', event.target.checked)} />保留更新前的旧容器
              </label>
              {typeof form.keepOldContainer !== 'boolean' && <p className="text-xs text-amber-600 dark:text-amber-400">请升级当前设备后配置旧容器保留策略。</p>}
            </div>
          </section>
          <section className="settings-section card rounded-2xl overflow-hidden">
            <div className="settings-section-header px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700"><h3 className="font-semibold flex items-center gap-2"><Network className="h-5 w-5 text-primary-600 dark:text-primary-400" />网络设置</h3></div>
            <div className="settings-section-body px-4 sm:px-6 py-4 grid sm:grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-3">
              <label htmlFor="registry-proxy" className="block sm:flex sm:items-center sm:min-h-[38px] text-sm font-medium">代理地址</label>
              <div className="min-w-0 space-y-2">
                <input id="registry-proxy" disabled={busy} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} type="text" inputMode="url" aria-invalid={invalid('proxy') || undefined} aria-describedby={invalid('proxy') ? 'registry-proxy-error' : undefined} className={`input min-h-[44px] sm:min-h-0 text-sm font-mono ${invalid('proxy') ? 'border-red-400 dark:border-red-500 focus:ring-red-500' : ''}`} placeholder="http://proxy.example:7890" value={form.httpsProxy || form.httpProxy || ''} {...autosave.inputProps('proxy')} onChange={event => {
                  const value = event.target.value
                  autosave.change('proxy', { httpProxy: value, httpsProxy: value }, 500)
                }} />
                <AutosaveFeedback autosave={autosave} target="proxy" id="registry-proxy-error" />
                {form.httpProxy !== form.httpsProxy && <p className="text-xs text-amber-600 dark:text-amber-400">HTTP/HTTPS 配置不同，修改后统一。</p>}
              </div>
              <label htmlFor="github-proxy" className="block sm:flex sm:items-center sm:min-h-[38px] text-sm font-medium">GitHub 加速地址</label>
              <div className="min-w-0 space-y-2">
                <input id="github-proxy" disabled={busy || typeof form.githubProxy !== 'string'} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} type="text" inputMode="url" aria-invalid={invalid('githubProxy') || undefined} aria-describedby={invalid('githubProxy') ? 'github-proxy-error' : undefined} className={`input min-h-[44px] sm:min-h-0 text-sm font-mono ${invalid('githubProxy') ? 'border-red-400 dark:border-red-500 focus:ring-red-500' : ''}`} placeholder="https://github-proxy.example" value={form.githubProxy ?? ''} {...autosave.inputProps('githubProxy')} onChange={event => change('githubProxy', event.target.value, 500)} />
                <AutosaveFeedback autosave={autosave} target="githubProxy" id="github-proxy-error" />
                {typeof form.githubProxy !== 'string' && <p className="text-xs text-amber-600 dark:text-amber-400">请升级当前设备后配置 GitHub 加速地址。</p>}
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
