export function getExclusionOptions({ excludedContainers = [], excludedServices = [] }, containers, projects) {
  const containerRules = new Set(excludedContainers)
  const serviceRules = new Set(excludedServices)
  const containersByID = new Map(containers.map(container => [container.id, container]))
  const services = projects.flatMap(project => project.services.map(service => ({
    value: `${project.id}/${service.name}`,
    label: `${project.name}/${service.name}`,
    containers: service.containers || [],
  })))
  // 按实际 ID 确认归属，避免同名但不同目录的项目共享排除状态。
  const servicesByContainer = new Map(services.flatMap(service => service.containers.map(id => [id, service])))
  const shownContainers = new Set()
  const shownServices = new Set()
  const options = containers.map(container => {
    const service = servicesByContainer.get(container.id)
    const rules = service ? service.containers.flatMap(id => containersByID.has(id) ? [id, containersByID.get(id).name] : [id]) : [container.id, container.name]
    rules.forEach(rule => shownContainers.add(rule))
    if (service) shownServices.add(service.value)
    const selected = (!!service && serviceRules.has(service.value)) || rules.some(rule => containerRules.has(rule))
    const unavailable = !!container.composeProject && !service
    return {
      value: `container:${container.id}`,
      label: container.name,
      detail: unavailable ? `${container.composeProject} · 所属服务暂不可用，请刷新后再试` : service?.label || container.usingImage,
      selected,
      disabled: unavailable && !selected,
      containerName: container.name,
      containerRules: rules,
      serviceRule: service?.value,
    }
  })
  // 列表缺项或读取失败时，旧规则仍能查看和移除；不能随候选列表变化自动丢弃。
  for (const rule of excludedContainers.filter(rule => !shownContainers.has(rule))) {
    options.push({ value: `container-rule:${rule}`, label: rule, detail: '暂不在列表中', selected: true, containerRules: [rule] })
  }
  for (const rule of excludedServices.filter(rule => !shownServices.has(rule))) {
    options.push({ value: `service-rule:${rule}`, label: services.find(service => service.value === rule)?.label || rule, detail: '暂无对应容器', selected: true, serviceRule: rule })
  }
  return options
}

export function changeExclusion(settings, option, selected) {
  if (!option) return { excludedContainers: [], excludedServices: [] }
  // 取消任一副本时同时移除该服务的旧 ID、名称和服务规则，避免留下看不见的排除。
  const excludedContainers = settings.excludedContainers.filter(rule => !option.containerRules?.includes(rule))
  const excludedServices = settings.excludedServices.filter(rule => rule !== option.serviceRule)
  if (selected) {
    // 项目规则跟随服务，容器重建或副本增减不会使新选择的排除失效。
    if (option.serviceRule) excludedServices.push(option.serviceRule)
    else excludedContainers.push(option.containerName)
  }
  return { excludedContainers, excludedServices }
}
