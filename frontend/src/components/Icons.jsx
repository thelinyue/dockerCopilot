import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Copy, Eye, Star, Check, Upload, Trash2, RefreshCw, X } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DeviceImage } from './DeviceImage.jsx'
import { cn } from '../utils/cn.js'
import { builtInImageLogos } from '../config/imageLogos.js'
import { useDeviceAPI } from '../hooks/useDevice.jsx'
import { useIcons } from '../hooks/useIcons.js'
import { iconAssetOptions } from '../hooks/iconAssets.js'
import { ICON_ACCEPT, iconFilename, iconId, migrateFavorites, normalizeImageRepository } from '../utils/icons.js'
import { Dialog, Notice, SettingsPanel, useConfirmation } from './ManagementUI.jsx'

const EMPTY_ICONS = {}
const categories = { all: '全部图标', custom: '自定义图标', builtin: '内置图标', favorites: '收藏' }

function readFavorites(deviceId) {
  try { return JSON.parse(localStorage.getItem(`docker_copilot_icon_favorites:${deviceId}`) || '[]') }
  catch { return [] }
}

export function Icons({ layout }) {
  const { deviceId, managementAPI, imageAPI } = useDeviceAPI()
  const client = useQueryClient()
  const confirm = useConfirmation()
  const query = useIcons()
  const customIcons = query.data || EMPTY_ICONS
  const [searchTerm, setSearchTerm] = useState('')
  const [category, setCategory] = useState('all')
  const [favorites, setFavorites] = useState(() => {
    const saved = readFavorites(deviceId)
    return Array.isArray(saved) ? saved : []
  })
  const [selected, setSelected] = useState(null)
  const [uploadTarget, setUploadTarget] = useState(null)
  const [uploadName, setUploadName] = useState('')
  const [uploadFile, setUploadFile] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [copied, setCopied] = useState(null)
  const [manualCopy, setManualCopy] = useState(null)
  const selectedAsset = useQuery({ ...iconAssetOptions(deviceId, managementAPI, selected?.url), enabled: !!selected && iconFilename(selected.url) !== null })
  const copyTimer = useRef(null)
  const previews = useRef(new Set())
  const uploadButton = useRef(null)
  const selectedTrigger = useRef(null)
  const entries = useMemo(() => [
    ...Object.entries(customIcons).map(([name, url]) => ({ source: 'custom', name, url })),
    ...Object.entries(builtInImageLogos).map(([name, url]) => ({ source: 'builtin', name, url })),
  ], [customIcons])

  useEffect(() => {
    const next = migrateFavorites(readFavorites(deviceId), entries, query.isFetched && !query.isError)
    setFavorites(next)
    try { localStorage.setItem(`docker_copilot_icon_favorites:${deviceId}`, JSON.stringify(next)) }
    catch { setError('浏览器无法保存收藏，当前收藏仅在本次页面中有效') }
  }, [deviceId, entries, query.dataUpdatedAt, query.isFetched, query.isError])

  useEffect(() => () => {
    clearTimeout(copyTimer.current)
    for (const url of previews.current) URL.revokeObjectURL(url)
  }, [])

  const toggleFavorite = entry => {
    const id = iconId(entry)
    const next = favorites.includes(id) ? favorites.filter(item => item !== id) : [...favorites, id]
    setFavorites(next)
    try { localStorage.setItem(`docker_copilot_icon_favorites:${deviceId}`, JSON.stringify(next)) }
    catch { setError('浏览器无法保存收藏，当前收藏仅在本次页面中有效') }
  }

  const getBlob = url => client.fetchQuery(iconAssetOptions(deviceId, managementAPI, url))
  const copyIcon = async (entry, dataLink = false) => {
    setError('')
    try {
      let link = entry.url
      if (iconFilename(entry.url) !== null && dataLink) {
        const blob = await getBlob(entry.url)
        link = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.onerror = () => reject(new Error('图像数据读取失败，请重试'))
          reader.readAsDataURL(blob)
        })
      } else link = iconFilename(entry.url) !== null ? imageAPI.iconURL(iconFilename(entry.url)) : new URL(entry.url, window.location.href).href
      if (!navigator.clipboard?.writeText) { setManualCopy({ link, reason: '当前浏览器或连接方式不支持自动复制' }); return }
      try { await navigator.clipboard.writeText(link) }
      catch (err) { setManualCopy({ link, reason: err.name === 'NotAllowedError' ? '浏览器拒绝访问剪贴板' : `自动复制失败：${err.message || '剪贴板暂不可用'}` }); return }
      setCopied(dataLink ? `data:${iconId(entry)}` : iconId(entry))
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(null), 2000)
    } catch (err) { setError(err.message || '复制失败，请重试') }
  }

  const openIcon = async entry => {
    const preview = window.open('', '_blank')
    if (!preview) { setError('新窗口被浏览器拦截，请允许弹出窗口后重试'); return }
    preview.opener = null
    setError('')
    try {
      if (iconFilename(entry.url) === null) preview.location.replace(new URL(entry.url, window.location.href).href)
      else {
        const url = URL.createObjectURL(await getBlob(entry.url))
        previews.current.add(url)
        preview.location.replace(url)
        setTimeout(() => { URL.revokeObjectURL(url); previews.current.delete(url) }, 60000)
      }
    } catch (err) { preview.close(); setError(err.message || '图标读取失败，请重试') }
  }

  const startUpload = entry => {
    if (!entry) selectedTrigger.current = null
    setSelected(null)
    setError('')
    setMessage('')
    const name = entry ? normalizeImageRepository(entry.name) : ''
    setUploadTarget(entry ? name : '')
    setUploadName(name)
    setUploadFile(null)
  }
  // 删除或归并历史标签会移除原卡片，焦点回到仍存在的入口，避免停留在 document.body。
  const restoreLibraryFocus = () => requestAnimationFrame(() => {
    const target = selectedTrigger.current?.isConnected ? selectedTrigger.current : uploadButton.current
    target?.focus({ preventScroll: true })
  })
  const submitUpload = async event => {
    event.preventDefault()
    if (pending) return
    setError('')
    setPending(true)
    try {
      setMessage(await query.upload(uploadFile, uploadName.trim()))
      setUploadTarget(null)
      restoreLibraryFocus()
    } catch (err) { setError(err.message || '上传失败，请重试') }
    finally { setPending(false) }
  }
  const deleteIcon = async entry => {
    const repository = normalizeImageRepository(entry.name)
    if (!await confirm({ title: '删除自定义图标', message: `设备：${query.deviceName}\n镜像仓库：${repository}\n删除后，该仓库全部标签恢复内置或默认图标。`, confirmText: '删除', danger: true })) return
    setError('')
    setMessage('')
    setPending(true)
    try { setMessage(await query.remove(repository)); setSelected(null); restoreLibraryFocus() }
    catch (err) { setError(err.message || '删除失败，请重试') }
    finally { setPending(false) }
  }

  const term = searchTerm.trim().toLowerCase()
  const filtered = entries.filter(entry => (!term || entry.name.toLowerCase().includes(term)) && (
    category === 'all' || (category === 'favorites' ? favorites.includes(iconId(entry)) : entry.source === category)
  ))
  const favoriteCount = entries.filter(entry => favorites.includes(iconId(entry))).length
  const resultLoading = query.isPending && (category === 'custom' || category === 'favorites')
  const queryNotice = query.isError && <Notice>自定义图标读取失败：{query.error.message} <button type="button" disabled={query.isFetching} onClick={() => query.refetch()} className="underline disabled:opacity-50">重试</button></Notice>
  const showGlobalError = !selected && uploadTarget === null
  return <SettingsPanel {...layout} actions={<>
    <button type="button" className="btn-secondary gap-2 disabled:opacity-50" disabled={query.isFetching || pending} onClick={() => query.refetch()}><RefreshCw className={cn('h-4 w-4', query.isFetching && 'animate-spin')} />刷新</button>
    <button ref={uploadButton} type="button" className="btn-primary gap-2" onClick={() => startUpload(null)}><Upload className="h-4 w-4" />上传图标</button>
  </>}>
    <div className="space-y-3">
      {queryNotice}
      {showGlobalError && <Notice onClose={() => setError('')}>{error}</Notice>}
      <Notice type={message.includes('回收失败') ? 'warning' : 'success'} onClose={() => setMessage('')}>{message}</Notice>
      <div className="card p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input type="search" aria-label="搜索图标名称" placeholder="搜索图标名称" value={searchTerm} onChange={event => setSearchTerm(event.target.value)} className="input pl-10 pr-12 [&::-webkit-search-cancel-button]:appearance-none" />
          {searchTerm && <button type="button" aria-label="清空图标搜索" onClick={() => setSearchTerm('')} className="btn-icon-secondary absolute right-0 top-0 h-full inline-flex items-center justify-center"><X className="w-4 h-4" /></button>}
        </div>
        <div className="flex items-center gap-3">
          <select aria-label="图标分类" value={category} onChange={event => setCategory(event.target.value)} className="input flex-1 sm:flex-none sm:w-40">
            {Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}{value === 'favorites' ? ` (${favoriteCount})` : ''}</option>)}
          </select>
          <span role="status" className="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{query.isFetching && !query.data ? '加载中…' : `${filtered.length} 个`}</span>
        </div>
      </div>
    </div>

    <div className="py-4 space-y-6">
      {['custom', 'builtin'].map(source => {
        const group = filtered.filter(entry => entry.source === source)
        if (!group.length) return null
        return <section key={source} aria-label={categories[source]}>
          <h3 className="font-semibold mb-3">{categories[source]}</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
            {group.map(entry => {
              const id = iconId(entry)
              const favorite = favorites.includes(id)
              return <article key={id} className="card p-3 sm:p-4 rounded-2xl flex flex-col min-w-0">
                <button type="button" aria-label={`查看${categories[source]} ${entry.name}`} className="flex-1 min-w-0 w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500" onClick={event => { selectedTrigger.current = event.currentTarget; setError(''); setSelected(entry) }}>
                  <DeviceImage src={entry.url} alt={entry.name} className="w-12 h-12 mx-auto object-contain rounded-lg" />
                  <span className="block text-xs font-medium truncate mt-3 text-gray-700 dark:text-gray-300" title={entry.name}>{entry.name}</span>
                </button>
                <div className="flex justify-between mt-3 pt-2 border-t border-gray-100 dark:border-gray-700">
                  <button type="button" aria-label={`${favorite ? '取消收藏' : '收藏'}${categories[source]} ${entry.name}`} title={favorite ? '取消收藏' : '收藏'} aria-pressed={favorite} onClick={() => toggleFavorite(entry)} className="btn-icon-secondary"><Star className={cn('h-4 w-4', favorite && 'text-yellow-500 fill-current')} /></button>
                  <button type="button" aria-label={`复制 ${entry.name}`} title={copied === id ? '已复制' : '复制链接'} onClick={() => copyIcon(entry)} className="btn-icon-secondary">{copied === id ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}</button>
                </div>
              </article>
            })}
          </div>
        </section>
      })}
      {!filtered.length && <div className="text-center py-12 text-gray-500 dark:text-gray-400">
        {resultLoading ? <RefreshCw className="h-10 w-10 mx-auto mb-3 animate-spin" /> : category === 'favorites' && !term ? <Star className="h-10 w-10 mx-auto mb-3" /> : <Search className="h-10 w-10 mx-auto mb-3" />}
        <h3 className="text-sm font-medium text-gray-900 dark:text-white" role={resultLoading ? 'status' : undefined}>{resultLoading ? '加载中…' : query.isError && category === 'custom' ? '自定义图标读取失败' : term ? '没有找到图标' : category === 'favorites' ? '暂无收藏' : '暂无自定义图标'}</h3>
        {!resultLoading && <div className="flex flex-wrap items-center justify-center gap-3 mt-4">
          {category === 'custom' && !term && (query.isError
            ? <button type="button" className="btn-primary" disabled={query.isFetching} onClick={() => query.refetch()}>重试</button>
            : <button type="button" className="btn-primary gap-2" onClick={() => startUpload(null)}><Upload className="h-4 w-4" />上传图标</button>)}
          <button type="button" className="btn-secondary" onClick={() => { setSearchTerm(''); setCategory('all') }}>查看全部</button>
        </div>}
      </div>}
    </div>

    {selected && <Dialog title="图标详情" onClose={pending ? undefined : () => { setSelected(null); setError('') }}>
      <div className="p-6 space-y-4">
        <Notice onClose={() => setError('')}>{error}</Notice>
        {selectedAsset.isError && <Notice>图片读取失败：{selectedAsset.error.message} <button type="button" className="underline" disabled={selectedAsset.isFetching} onClick={() => selectedAsset.refetch()}>重试</button></Notice>}
        <div className="flex items-center gap-3">
          <DeviceImage eager src={selected.url} alt={selected.name} className="w-16 h-16 flex-shrink-0 object-contain rounded-xl" />
          <div className="min-w-0 flex-1"><p className="font-medium break-all">{selected.name}</p><p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{selected.source === 'custom' ? `自定义 · ${query.deviceName}` : '内置'}</p></div>
          <button type="button" aria-label={favorites.includes(iconId(selected)) ? '取消收藏' : '添加收藏'} title={favorites.includes(iconId(selected)) ? '取消收藏' : '添加收藏'} aria-pressed={favorites.includes(iconId(selected))} onClick={() => toggleFavorite(selected)} className="btn-icon-secondary flex-shrink-0"><Star className={cn('h-5 w-5', favorites.includes(iconId(selected)) && 'text-yellow-500 fill-current')} /></button>
        </div>
        <div><label htmlFor="icon-link" className="text-sm font-medium block mb-2">图标链接</label><div className="flex gap-2">
          <input id="icon-link" readOnly value={iconFilename(selected.url) !== null ? imageAPI.iconURL(iconFilename(selected.url)) : new URL(selected.url, window.location.href).href} onFocus={event => event.target.select()} className="input flex-1 min-w-0 text-sm" />
          <button type="button" className="btn-secondary flex-shrink-0 gap-2" onClick={() => copyIcon(selected)}>{copied === iconId(selected) ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied === iconId(selected) ? '已复制' : '复制'}</button>
        </div></div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <button type="button" className="inline-flex items-center gap-1.5 min-h-[44px] text-sm text-primary-600 dark:text-primary-400 hover:underline" onClick={() => openIcon(selected)}><Eye className="h-4 w-4" />查看原图</button>
          {selected.source === 'custom' && <button type="button" className="inline-flex items-center gap-1.5 min-h-[44px] text-sm text-primary-600 dark:text-primary-400 hover:underline" onClick={() => copyIcon(selected, true)}>{copied === `data:${iconId(selected)}` ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied === `data:${iconId(selected)}` ? '已复制数据链接' : '复制数据链接'}</button>}
        </div>
      </div>
      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30 flex items-center justify-between gap-3">
        {selected.source === 'custom' && <button type="button" disabled={pending} className="btn-secondary text-red-600 dark:text-red-400 gap-2 disabled:opacity-50" onClick={() => deleteIcon(selected)}><Trash2 className="h-4 w-4" />{pending ? '删除中…' : '删除'}</button>}
        <button type="button" disabled={pending} className="btn-primary gap-2 ml-auto disabled:opacity-50" onClick={() => startUpload(selected)}><Upload className="h-4 w-4" />{selected.source === 'custom' ? '替换图标' : '自定义图标'}</button>
      </div>
    </Dialog>}

    {uploadTarget !== null && <Dialog title={uploadTarget ? '替换图标' : '上传图标'} onClose={pending ? undefined : () => { setUploadTarget(null); setError('') }}>
      <form onSubmit={submitUpload}>
        <div className="p-6 space-y-4">
          <Notice>{error}</Notice>
          <dl className="flex items-center justify-between gap-3 text-sm"><dt className="text-gray-500 dark:text-gray-400">设备</dt><dd className="font-medium truncate" title={query.deviceName}>{query.deviceName}</dd></dl>
          <div><div className="flex items-center justify-between gap-3 mb-2"><label htmlFor="icon-image-name" className="text-sm font-medium">镜像仓库</label><span className="text-xs text-gray-500 dark:text-gray-400">全部标签</span></div><input id="icon-image-name" data-autofocus required disabled={pending} readOnly={!!uploadTarget} value={uploadName} onChange={event => setUploadName(event.target.value)} placeholder="redis 或 team/app" className="input disabled:opacity-50" /></div>
          <div><label htmlFor="icon-upload-file" className="block text-sm font-medium mb-2">图标文件</label><input id="icon-upload-file" type="file" required disabled={pending} accept={ICON_ACCEPT} aria-describedby="icon-file-format" onChange={event => setUploadFile(event.target.files[0] || null)} className="block w-full min-w-0 text-sm disabled:opacity-50 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-gray-100 dark:file:bg-gray-700 file:text-gray-700 dark:file:text-gray-200" /><p id="icon-file-format" className="mt-2 text-xs text-gray-500 dark:text-gray-400">PNG、JPEG、WebP、GIF · 最大 2 MiB</p></div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30 flex justify-end gap-3"><button type="button" disabled={pending} className="btn-secondary disabled:opacity-50" onClick={() => { setUploadTarget(null); setError('') }}>取消</button><button type="submit" disabled={pending} className="btn-primary disabled:opacity-50">{pending ? '上传中…' : uploadTarget ? '替换' : '上传'}</button></div>
      </form>
    </Dialog>}

    {manualCopy !== null && <Dialog title="手动复制" onClose={() => setManualCopy(null)}>
      <div className="p-6 space-y-3"><p className="text-sm text-gray-500 dark:text-gray-400">{manualCopy.reason}</p><textarea aria-label="待复制的图标链接" data-autofocus readOnly value={manualCopy.link} onFocus={event => event.target.select()} className="input h-32 text-sm font-mono" /></div>
    </Dialog>}
  </SettingsPanel>
}
