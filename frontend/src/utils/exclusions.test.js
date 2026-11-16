import assert from 'node:assert/strict'
import test from 'node:test'
import { getExclusionOptions, changeExclusion } from './exclusions.js'

const containers = [
  { id: 'cache-id', name: 'cache', usingImage: 'redis:7' },
  { id: 'web-1-id', name: 'media-web-1', composeProject: 'media' },
  { id: 'web-2-id', name: 'media-web-2', composeProject: 'media' },
  { id: 'db-id', name: 'media-db', composeProject: 'media' },
  { id: 'other-web-id', name: 'other-web', composeProject: 'media' },
]
const projects = [
  { id: 'project-a', name: 'media', services: [
    { name: 'web', containers: ['web-1-id', 'web-2-id'] },
    { name: 'db', containers: ['db-id'] },
    { name: 'offline', containers: [] },
  ] },
  { id: 'project-b', name: 'media', services: [{ name: 'web', containers: ['other-web-id'] }] },
]
const settings = (excludedContainers = [], excludedServices = []) => ({ excludedContainers, excludedServices })
const option = (options, name) => options.find(item => item.label === name)

test('旧 ID 和离线规则继续显示，取消独立容器只移除自身规则', () => {
  const current = settings(['cache-id', 'cache', 'offline-container'], ['missing-project/app'])
  const options = getExclusionOptions(current, containers, projects)
  assert.equal(option(options, 'cache').selected, true)
  assert.equal(option(options, 'offline-container').selected, true)
  assert.equal(option(options, 'missing-project/app').selected, true)
  assert.deepEqual(changeExclusion(current, option(options, 'cache'), false), settings(['offline-container'], ['missing-project/app']))
  assert.deepEqual(current, settings(['cache-id', 'cache', 'offline-container'], ['missing-project/app']))
})

test('新增独立容器按名称保存，项目容器按所属服务保存', () => {
  const current = settings([], ['project-a/db'])
  const options = getExclusionOptions(current, containers, projects)
  assert.deepEqual(changeExclusion(current, option(options, 'cache'), true), settings(['cache'], ['project-a/db']))
  const changed = changeExclusion(current, option(options, 'media-web-1'), true)
  assert.deepEqual(changed, settings([], ['project-a/db', 'project-a/web']))
  const updated = getExclusionOptions(changed, containers, projects)
  assert.equal(option(updated, 'media-web-1').selected, true)
  assert.equal(option(updated, 'media-web-2').selected, true)
  assert.equal(option(updated, 'other-web').selected, false)
})

test('从任一副本取消排除会清除同服务的旧 ID、名称及重复服务规则', () => {
  const current = settings(['web-1-id', 'media-web-2', 'offline-container', 'media-db'], ['project-a/web', 'project-b/web'])
  const options = getExclusionOptions(current, containers, projects)
  assert.equal(option(options, 'media-web-1').selected, true)
  assert.equal(option(options, 'media-web-2').selected, true)
  assert.equal(option(options, 'media-web-2').disabled, false)
  assert.equal(options.filter(item => item.serviceRule === 'project-a/web').length, 2)
  const changed = changeExclusion(current, option(options, 'media-web-2'), false)
  assert.deepEqual(changed, settings(['offline-container', 'media-db'], ['project-b/web']))
  const updated = getExclusionOptions(changed, containers, projects)
  assert.equal(option(updated, 'media-web-1').selected, false)
  assert.equal(option(updated, 'media-web-2').selected, false)
  assert.equal(option(updated, 'other-web').selected, true)
})

test('旧容器规则排除整个服务，容器重建后服务规则继续生效', () => {
  const legacy = getExclusionOptions(settings(['web-1-id']), containers, projects)
  assert.equal(option(legacy, 'media-web-2').selected, true)
  const replacement = [{ id: 'new-web-id', name: 'renamed-web', composeProject: 'media' }]
  const replacedProjects = [{ id: 'project-a', name: 'media', services: [{ name: 'web', containers: ['new-web-id'] }] }]
  assert.equal(option(getExclusionOptions(settings([], ['project-a/web']), replacement, replacedProjects), 'renamed-web').selected, true)
})

test('没有对应容器的服务规则仍可在同一入口查看和移除', () => {
  const current = settings([], ['project-a/offline', 'missing-project/app'])
  const options = getExclusionOptions(current, containers, projects)
  const offline = option(options, 'media/offline')
  assert.equal(offline.selected, true)
  assert.equal(offline.detail, '暂无对应容器')
  assert.deepEqual(changeExclusion(current, offline, false), settings([], ['missing-project/app']))
})

test('列表不可用时保留规则，归属未知的项目容器不能新增排除', () => {
  const current = settings(['cache-id', 'web-1-id'], ['project-a/web'])
  const options = getExclusionOptions(current, containers, [])
  assert.equal(option(options, 'media-web-1').selected, true)
  assert.equal(option(options, 'media-web-1').disabled, false)
  assert.equal(option(options, 'media-web-2').disabled, true)
  assert.equal(option(options, 'project-a/web').selected, true)
  assert.equal(getExclusionOptions(current, [], []).filter(item => item.selected).length, 3)
  assert.deepEqual(current, settings(['cache-id', 'web-1-id'], ['project-a/web']))
})

test('清空选择明确移除两类排除规则，包括离线规则', () => {
  const current = settings(['cache-id', 'offline-container'], ['project-a/web', 'missing-project/app'])
  assert.deepEqual(changeExclusion(current, null, false), settings())
  assert.deepEqual(current, settings(['cache-id', 'offline-container'], ['project-a/web', 'missing-project/app']))
})
