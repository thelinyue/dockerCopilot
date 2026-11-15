import React from 'react'
import { Github, MessageSquare } from 'lucide-react'
import logoImg from '../assets/DockerCopilot-logo.png'
import { SettingsPanel } from './ManagementUI.jsx'

export function About({ layout }) {
  return (
    <SettingsPanel {...layout}>
        {/* 项目展示卡片 */}
        <div className="card p-5 sm:p-6">
          <div className="flex items-center gap-4 mb-5">
            <img
              src={logoImg}
              alt="Docker Copilot"
              className="w-14 h-14 rounded-xl flex-shrink-0"
            />
            <div className="min-w-0">
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white">Docker Copilot</h3>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Docker 容器、项目与多设备管理</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <a
              href="https://github.com/thelinyue/dockerCopilot"
              target="_blank"
              rel="noopener noreferrer"
              className="btn gap-2 bg-gray-900 text-white hover:bg-gray-800"
            >
              <Github className="h-4 w-4" />
              <span>项目源码</span>
            </a>
            <a
              href="https://github.com/thelinyue/dockerCopilot/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="btn gap-2 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/50"
            >
              <MessageSquare className="h-4 w-4" />
              <span>问题反馈</span>
            </a>
          </div>
        </div>

    </SettingsPanel>
  )
}
