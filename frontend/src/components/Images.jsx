import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { HardDrive, Trash2, RefreshCw, ExternalLink, BrushCleaning } from 'lucide-react'
import { DeviceImage } from './DeviceImage.jsx'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { useViewState, useWorkspace } from '../hooks/useWorkspace.jsx'
import { getImageLogo } from '../config/imageLogos.js'
import { useIcons } from '../hooks/useIcons.js'
import { ActionMenu, ConnectionNotice, Dialog, Notice, PageHeader, ResourceFilters, Toast, useConfirmation } from './ManagementUI.jsx'

const isDangling = image => image.tag === 'None' || image.tag === '<none>'
const imageName = image => `${image.name}:${image.tag}`

export function Images() {
  const { deviceId, imageAPI } = useDeviceAPI()
  const workspace = useWorkspace()
  const confirm = useConfirmation()
  const query = useQuery({ queryKey: [deviceId, 'images'], queryFn: async () => (await imageAPI.getImages()).data.data || [] })
  const images = query.data || []
  const icons = useIcons()
  const [filter, setFilter] = useViewState('images:filter', null)
  const [selected, setSelected] = useState(null)
  const [prune, setPrune] = useState(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [message, setMessage] = useState('')
  const candidates = type => images.filter(image => !image.inUsed && (type === 'unused' || isDangling(image)))
  const disabled = busy || query.isPending || !!query.error || workspace?.online === false
  const remove = async (image, force = false) => {
    if (!await confirm({ title: force ? '强制删除镜像' : '删除镜像', message: `设备：${workspace?.deviceLabel || deviceId}\n${imageName(image)}\n${force ? '该镜像正在使用，强制删除可能影响后续容器创建与恢复。' : '删除后，需要重新拉取才能再次创建容器。'}`, confirmText: '删除', danger: true })) return
    setBusy(true)
    setFailure('')
    try {
      await imageAPI.deleteImage(image.id, force)
      setSelected(null)
      setMessage('镜像已删除')
    } catch (error) { setFailure(error.message) }
    finally { await query.refetch(); setBusy(false) }
  }
  const clean = async () => {
    const type = prune
    setPrune(null)
    setBusy(true)
    setFailure('')
    try {
      const response = await imageAPI.pruneImages(type)
      const { changed, spaceReclaimed = 0 } = response.data.data
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      const unit = spaceReclaimed > 0 ? Math.min(Math.floor(Math.log(spaceReclaimed) / Math.log(1024)), 4) : 0
      setMessage(changed ? `清理完成，释放 ${(spaceReclaimed / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}` : '没有可清理的镜像')
    } catch (error) { setFailure(error.message) }
    finally {
      // 超时可能已经回收部分镜像；重新读取实际状态，保留操作错误及上次列表。
      await query.refetch()
      setBusy(false)
    }
  }
  const menuFor = image => [
    { label: '在 Docker Hub 查看', icon: ExternalLink, href: `https://hub.docker.com/r/${image.name}` },
    { label: '删除镜像', icon: Trash2, danger: true, disabled, onClick: () => remove(image) },
    image.inUsed && { label: '强制删除', icon: Trash2, danger: true, disabled, onClick: () => remove(image, true) },
  ]
  const visible = images.filter(image => filter === 'used' ? image.inUsed : filter === 'unused' ? !image.inUsed : filter === 'dangling' ? isDangling(image) : true)
  return <div className="workspace-page max-w-7xl mx-auto text-gray-900 dark:text-gray-100">
    <PageHeader title="镜像" menu={[{ label: '刷新', icon: RefreshCw, disabled: query.isFetching || busy, onClick: () => query.refetch() }]}>
      <ActionMenu title="清理镜像" label="清理" icon={null} triggerClassName="page-action action-accent" disabled={disabled} items={[
        { label: '清理无 Tag 镜像', icon: BrushCleaning, count: candidates('dangling').length, disabled: !candidates('dangling').length, onClick: () => setPrune('dangling') },
        { label: '清理未使用镜像', icon: Trash2, count: candidates('unused').length, disabled: !candidates('unused').length, onClick: () => setPrune('unused') },
      ]} />
    </PageHeader>
    <ConnectionNotice error={query.error} hasData={!!query.data} retry={() => query.refetch()} busy={query.isFetching} />
    <Notice onClose={() => setFailure('')}>{failure}</Notice>
    {icons.isError && <Notice>图标读取失败：{icons.error.message}<button type="button" className="underline ml-2 min-h-[44px]" onClick={() => icons.refetch()}>重试</button></Notice>}
    <Toast onClose={() => setMessage('')}>{message}</Toast>
    <ResourceFilters value={filter} onChange={setFilter} items={[
      { id: null, label: '全部', count: images.length },
      { id: 'used', label: '使用中', count: images.filter(image => image.inUsed).length },
      { id: 'unused', label: '未使用', count: candidates('unused').length },
      { id: 'dangling', label: '无 Tag', count: images.filter(isDangling).length },
    ]} />
    {busy && <p role="status" className="flex items-center gap-2 text-sm text-primary-600 py-2"><RefreshCw className="h-4 w-4 animate-spin" />正在处理…</p>}
    {query.isPending ? <div className="resource-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" aria-label="正在加载镜像">{[1,2,3].map(id => <div key={id} className="card h-28 animate-pulse" />)}</div> : visible.length ? <div className="resource-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {visible.map(image => <article key={`${image.id}:${imageName(image)}`} aria-label={`镜像 ${imageName(image)}`} className="resource-card card p-4 flex items-start gap-2 min-w-0">
        <button type="button" className="min-w-0 flex-1 flex items-center gap-3 text-left rounded-lg min-h-[64px] focus-visible:ring-2 focus-visible:ring-primary-500" onClick={() => setSelected(image)} aria-label={`查看镜像 ${imageName(image)}`}>
          <span className="h-10 w-10 shrink-0 rounded-xl bg-gray-100 dark:bg-gray-700 flex items-center justify-center overflow-hidden"><DeviceImage src={getImageLogo(imageName(image), icons.icons)} alt="" className="h-10 w-10 object-cover" fallback={<HardDrive className="h-5 w-5 text-gray-400" />} /></span>
          <span className="min-w-0 flex-1"><span className="block font-semibold text-sm truncate" title={image.name}>{image.name}</span><span className="block text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">{image.tag}</span><span className="block text-xs text-gray-500 dark:text-gray-400 mt-1">{image.inUsed ? '使用中' : '未使用'} · {image.size}</span></span>
        </button>
        <ActionMenu title={`${imageName(image)} 更多操作`} items={menuFor(image)} />
      </article>)}
    </div> : <div className="py-12 text-center text-sm text-gray-500">{query.error ? '镜像读取失败' : images.length ? '没有匹配的镜像' : '暂无镜像'}</div>}
    {selected && <Dialog title="镜像详情" onClose={() => setSelected(null)}><div className="p-5 space-y-4 text-sm">
      <ConnectionNotice error={query.error} hasData={!!query.data} retry={() => query.refetch()} busy={query.isFetching} />
      <p className="font-medium break-all">{imageName(selected)}</p><p className="text-gray-500 break-all font-mono text-xs">{selected.id}</p><p>{selected.inUsed ? '使用中' : '未使用'} · {selected.size}</p>
      <Notice>{failure}</Notice><div className="flex items-center justify-end gap-2"><button type="button" className="btn-danger disabled:opacity-50" disabled={disabled} onClick={() => remove(selected)}>删除</button><ActionMenu title="镜像操作" items={menuFor(selected)} /></div>
    </div></Dialog>}
    {prune && <Dialog title={prune === 'dangling' ? '清理无 Tag 镜像' : '清理未使用镜像'} onClose={() => setPrune(null)}>
      <div className="p-5 space-y-3 text-sm"><p>设备：{workspace?.deviceLabel || deviceId}</p><p>将清理 {candidates(prune).length} 个未被容器引用的镜像。</p><ul className="max-h-48 overflow-y-auto space-y-1 text-xs text-gray-500 break-all">{candidates(prune).map(image => <li key={`${image.id}:${imageName(image)}`}>{imageName(image)}</li>)}</ul><p className="text-xs text-gray-500">实际范围以设备执行时的引用状态为准；后续使用需重新拉取。</p></div>
      <div className="border-t border-gray-200 dark:border-gray-700 p-4 flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setPrune(null)}>取消</button><button type="button" className="btn-danger disabled:opacity-50" disabled={disabled || !candidates(prune).length} onClick={clean}>确认清理</button></div>
    </Dialog>}
  </div>
}
