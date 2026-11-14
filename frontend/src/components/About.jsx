import React from 'react'
import { Github, MessageSquare } from 'lucide-react'
import logoImg from '../assets/DockerCopilot-logo.png'

export function About() {
  return (
    <div className="max-w-7xl mx-auto">

      <div className="px-2 sm:px-6 py-4 pt-4 sm:pt-4 space-y-6">
        {/* 项目展示卡片 */}
        <div className="card p-8 flex flex-col items-center text-center relative overflow-hidden">
          <div className="relative mb-4">
            <div className="absolute inset-0 bg-primary-400/20 blur-xl rounded-full"></div>
            <img
              src={logoImg}
              alt="Docker Copilot"
              className="relative w-20 h-20 rounded-2xl shadow-lg"
            />
          </div>

          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Docker Copilot</h1>
          <p className="text-gray-600 dark:text-gray-400 max-w-lg mx-auto mb-6">
            Docker 容器、项目与多设备管理
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <a
              href="https://github.com/thelinyue/dockerCopilot"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors shadow-sm"
            >
              <Github className="h-4 w-4" />
              <span>项目源码</span>
            </a>
            <a
              href="https://github.com/thelinyue/dockerCopilot/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 rounded-lg hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
            >
              <MessageSquare className="h-4 w-4" />
              <span>问题反馈</span>
            </a>
          </div>
        </div>

      </div>
    </div>
  )
}
