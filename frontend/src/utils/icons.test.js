import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeImageRepository, resolveCustomIcon, resolveImageLogo, iconId, migrateFavorites, validateIconFile, remapRepositoryFavorites } from './icons.js'

test('镜像仓库规范化区分端口、标签和摘要，合并 Docker Hub 官方别名', () => {
  assert.equal(normalizeImageRepository('registry.local:5000/team/app:7'), 'registry.local:5000/team/app')
  assert.equal(normalizeImageRepository('team/app@sha256:abc'), 'team/app')
  assert.equal(normalizeImageRepository('registry.local:5000/team/app:7@sha256:abc'), 'registry.local:5000/team/app')
  for (const name of ['redis:7', 'library/redis:8', 'docker.io/library/redis:9', 'index.docker.io/library/redis']) {
    assert.equal(normalizeImageRepository(name), 'redis')
  }
  assert.equal(normalizeImageRepository(''), '')
})

test('自定义图标跨标签并优先于内置，不匹配其他仓库或相似前缀', () => {
  const custom = { 'registry.local:5000/team/app-a': 'A', redis: 'CUSTOM' }
  const builtin = { redis: 'BUILTIN' }
  assert.equal(resolveImageLogo('redis:8', custom, builtin), 'CUSTOM')
  assert.equal(resolveCustomIcon('registry.local:5000/team/app-a:2', custom), 'A')
  assert.equal(resolveCustomIcon('registry.local:5000/team/app-b:2', custom), null)
  assert.equal(resolveCustomIcon('other/redis:7', custom), null)
  assert.equal(resolveCustomIcon('redis:8@sha256:abc', custom), 'CUSTOM')
  assert.equal(resolveImageLogo('my-redis-helper:1', {}, builtin), null)
})

test('历史单图跨标签，多图保留精确对应，仓库级配置优先', () => {
  assert.equal(resolveCustomIcon('team/app:2', { 'team/app:1': 'OLD' }), 'OLD')
  const old = { 'team/app:1': 'ONE', 'team/app:2': 'TWO' }
  assert.equal(resolveCustomIcon('team/app:1', old), 'ONE')
  assert.equal(resolveCustomIcon('team/app:3', old), null)
  assert.equal(resolveCustomIcon('team/app:1', { ...old, 'team/app': 'ALL' }), 'ALL')
})

test('内置仅匹配明确的完整名称和简单名称别名', () => {
  const builtin = { 'vendor/app': 'APP', redis: 'REDIS' }
  assert.equal(resolveImageLogo('ghcr.io/vendor/app:2', {}, builtin), 'APP')
  assert.equal(resolveImageLogo('other/app:2', {}, builtin), null)
  assert.equal(resolveImageLogo('vendor/app-helper:2', {}, builtin), null)
  assert.equal(resolveImageLogo('team/redis:7', {}, builtin), 'REDIS')
})

test('旧收藏迁移保留来源，重名两项分别计数，等待自定义列表读取成功', () => {
  const entries = [{ source: 'builtin', name: 'redis' }, { source: 'custom', name: 'redis' }]
  assert.notEqual(iconId(entries[0]), iconId(entries[1]))
  assert.deepEqual(migrateFavorites(['redis'], entries, true), [iconId(entries[0]), iconId(entries[1])])
  assert.deepEqual(migrateFavorites(['redis'], entries.slice(0, 1), false), ['redis', iconId(entries[0])])
  assert.deepEqual(migrateFavorites({}, entries, true), [])
  assert.deepEqual(migrateFavorites([iconId(entries[0]), iconId(entries[0])], entries, true), [iconId(entries[0])])
  assert.deepEqual(migrateFavorites(['custom:7'], [{ source: 'custom', name: 'custom:7' }], true), ['custom|custom:7'])
})

test('上传格式与 2 MiB 上限给出中文错误', () => {
  assert.equal(validateIconFile({ name: 'icon.gif', size: 2 * 1024 * 1024 }), '')
  assert.match(validateIconFile({ name: 'icon.png', size: 2 * 1024 * 1024 + 1 }), /2 MiB/)
  assert.match(validateIconFile({ name: 'icon.svg', size: 30 }), /不支持 SVG/)
  assert.match(validateIconFile({ name: 'icon.txt', size: 30 }), /PNG/)
})

test('替换归并历史自定义收藏，恢复默认保留同名内置收藏', () => {
  const before = ['redis', 'custom|redis:7', 'custom|team/other']
  assert.deepEqual(remapRepositoryFavorites(before, 'redis', ['redis', 'redis:7'], true, ['redis']), ['builtin|redis', 'custom|team/other', 'custom|redis'])
  assert.deepEqual(remapRepositoryFavorites(before, 'redis', ['redis', 'redis:7'], false, ['redis']), ['builtin|redis', 'custom|team/other'])
})
