import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Plug, Copy, Check, FileText, X } from 'lucide-react';
import clsx from 'clsx';
import { useAuthStore } from '../store/useAuthStore';
import ReactMarkdown from 'react-markdown';
import { toast } from 'react-toastify';

const isTauri = typeof window !== 'undefined' && (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));

interface McpStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  username: string;
  endpoint: string;
}

// Settings card for the local MCP server: exposes the collection to external
// AI agents (Claude Code, Cursor, ...) via MCP Streamable HTTP on localhost.
export const McpPanel: React.FC = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [portInput, setPortInput] = useState('');
  const [userInput, setUserInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    invoke<McpStatus>('mcp_get_status').then((s) => {
      setStatus(s);
      setPortInput(String(s.port));
      setUserInput(s.username);
    }).catch(console.error);
  }, []);

  if (!isTauri || !status) return null;

  const apply = async (patch: Partial<{ enabled: boolean; port: number; username: string }>) => {
    const next = {
      enabled: patch.enabled ?? status.enabled,
      port: patch.port ?? (Number(portInput) || status.port),
      username: patch.username ?? userInput,
    };
    try {
      const s = await invoke<McpStatus>('mcp_set_config', { config: next });
      setStatus(s);
    } catch (e) {
      console.error(e);
    }
  };

  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(status.endpoint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  // Paste-ready documentation, shown in the modal and copyable in two
  // granularities: the full setup guide (client configs + tool reference)
  // for reading, and an agent-only brief to paste straight into an agent chat.
  const agentBrief = `# MediaTrove MCP 使用说明（发给 AI 助手）

你（AI 助手）可以通过 MCP 协议直接读写用户本机的 MediaTrove 媒体收藏库。MCP 端点：\`${status.endpoint}\`（数据归属用户「${status.username}」，应用需处于运行状态）。

## 可用工具

| 工具 | 用途 |
| --- | --- |
| list_items | 列出收藏；可按分类（Favorites / To Watch / Watched）、类型（Book / Movie / TV Series / Comic / Short Drama / Music / Other）过滤，或按标题/简介模糊搜索 |
| get_item | 按 id 查看单条详情 |
| add_item | 新增收藏条目（默认 To Watch 分类） |
| update_item | 更新条目：分类、观看进度 userProgress、短评 userReview、最新进度 latestUpdateInfo 等（只传需要改的字段） |
| remove_item | 按 id 删除条目 |
| get_stats | 收藏统计：各分类、各类型数量 |
| get_update_reminders | 追更提醒：连载中新条目；传 only_new=true 只看有新更新的 |
| list_characters | 列出从收藏作品中提炼的角色扮演人格 |
| chat_with_character | 与指定角色进行角色扮演对话（走应用内 AI 配置，应用需开启） |

## 使用注意

- 所有写操作实时写回应用并触发界面刷新，请避免重复提交相同变更。
- 删除操作不可撤销，执行前先向用户确认。
- 观看进度遵循应用约定：季内进度写 "S{n}E{m}"，扁平进度（漫画/书）写最后一话/章的数字（如 "第680话"）。`;

  const guideMarkdown = `# MediaTrove MCP 配置说明

MediaTrove 通过 MCP（Streamable HTTP）在本地暴露收藏库，任何支持远程 MCP 的客户端都可以接入。仅监听本机 127.0.0.1，不会暴露到网络。

## 一、连接信息

- 端点：\`${status.endpoint}\`
- 数据用户：\`${status.username}\`（MCP 读写该用户的收藏）
- 前提：应用处于运行状态、MCP 开关已打开

## 二、客户端接入

**Claude Code**（命令行一条完成）：

\`\`\`bash
claude mcp add --transport http mediatrove ${status.endpoint}
\`\`\`

**Cursor / Cline 等通用 mcpServers 配置**：

\`\`\`json
{
  "mcpServers": {
    "mediatrove": { "url": "${status.endpoint}" }
  }
}
\`\`\`

**Claude Desktop**（claude_desktop_config.json，支持远程 MCP 的版本）：

\`\`\`json
{
  "mcpServers": {
    "mediatrove": { "url": "${status.endpoint}" }
  }
}
\`\`\`

## 三、验证

接入后在客户端里执行一次 \`list_items\`：能返回收藏条目即为连通；空列表说明端点或数据用户填错。

## 四、Agent 使用说明

把下方「Agent 使用说明」按钮复制的内容直接粘贴给 Agent，它即可使用全部工具。

---

${agentBrief}`;

  const copyGuide = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(message);
      setShowGuide(false);
    } catch {}
  };

  return (
    <div className="bg-theme-surface border border-theme-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4 border-b border-theme-border pb-3">
        <div className="flex items-center gap-2">
          <Plug className="w-5 h-5 text-theme-accent" />
          <h2 className="text-xl font-bold text-theme-text">{t('mcp.title')}</h2>
          <span
            className={clsx(
              'ml-2 flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border',
              status.running
                ? 'bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-500'
                : 'bg-theme-bg border-theme-border text-theme-subtext'
            )}
          >
            <span className={clsx('w-1.5 h-1.5 rounded-full', status.running ? 'bg-green-500' : 'bg-theme-subtext')} />
            {status.running ? t('mcp.status_running') : t('mcp.status_stopped')}
          </span>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={status.enabled}
            onChange={(e) => apply({ enabled: e.target.checked })}
            className="sr-only peer"
          />
          <div className="w-11 h-6 relative shrink-0 bg-theme-border border-2 border-theme-subtext/20 rounded-full peer peer-focus:ring-2 peer-focus:ring-theme-accent peer-checked:bg-gradient-to-r peer-checked:from-theme-accent-warm peer-checked:to-theme-accent-warm-2 after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-[16px]"></div>
        </label>
      </div>

      <p className="text-xs text-theme-subtext mb-4">{t('mcp.desc')}</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-theme-text mb-1">{t('mcp.port_label')}</label>
          <input
            type="number"
            min={1024}
            max={65535}
            value={portInput}
            disabled={!status.enabled}
            onChange={(e) => setPortInput(e.target.value)}
            onBlur={() => {
              const p = Number(portInput);
              if (p >= 1024 && p <= 65535 && p !== status.port) apply({ port: p });
              else setPortInput(String(status.port));
            }}
            className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-theme-text mb-1">{t('mcp.user_label')}</label>
          <input
            type="text"
            value={userInput}
            disabled={!status.enabled}
            placeholder={useAuthStore.getState().user?.username || 'guest'}
            onChange={(e) => setUserInput(e.target.value)}
            onBlur={() => {
              const u = userInput.trim();
              if (u && u !== status.username) apply({ username: u });
              else setUserInput(status.username);
            }}
            className="w-full px-4 py-2 rounded-lg border bg-theme-bg border-theme-border text-theme-text focus:ring-2 focus:ring-theme-accent outline-none disabled:opacity-50"
          />
          <p className="text-xs text-theme-subtext/70 mt-1">{t('mcp.user_hint')}</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-theme-text mb-1">{t('mcp.endpoint_label')}</label>
          <div className="flex">
            <input
              type="text"
              readOnly
              value={status.enabled ? status.endpoint : t('mcp.status_stopped')}
              className="flex-1 min-w-0 px-4 py-2 rounded-l-lg border border-r-0 bg-theme-bg border-theme-border text-theme-text text-xs font-mono outline-none"
            />
            <button
              type="button"
              onClick={copyEndpoint}
              disabled={!status.enabled}
              className="px-3 rounded-r-lg border border-theme-border bg-theme-surface text-theme-subtext hover:text-theme-accent hover:border-theme-accent transition-colors disabled:opacity-50"
              title={t('mcp.copy_endpoint')}
            >
              {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {status.enabled && (
        <div className="mt-4 p-3 rounded-lg bg-theme-bg/50 border border-theme-border text-xs text-theme-subtext leading-relaxed">
          <p className="mb-1 font-medium text-theme-text">{t('mcp.connect_hint_title')}</p>
          <p><code className="text-theme-accent">claude mcp add --transport http mediatrove {status.endpoint}</code></p>
          <p className="mt-1">{t('mcp.connect_hint')}</p>
          {/* One-click handoff: the setup guide for reading, the agent brief
              for pasting straight into an agent chat. */}
          <button
            type="button"
            onClick={() => setShowGuide(true)}
            className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-theme-accent hover:text-theme-accent-hover hover:underline transition-colors"
          >
            <FileText className="w-3.5 h-3.5" />
            {t('mcp.guide_button')}
          </button>
        </div>
      )}

      {showGuide && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowGuide(false)}>
          <div className="bg-theme-surface border border-theme-border rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[85vh]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-theme-border">
              <h3 className="text-lg font-bold text-theme-text">{t('mcp.guide_title')}</h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="p-1 rounded-md text-theme-subtext hover:bg-theme-bg hover:text-theme-text transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto custom-scrollbar prose prose-sm max-w-none text-theme-text">
              <ReactMarkdown>{guideMarkdown}</ReactMarkdown>
            </div>
            <div className="p-4 border-t border-theme-border flex items-center justify-between gap-2 flex-wrap">
              <p className="text-xs text-theme-subtext">{t('mcp.guide_hint')}</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => copyGuide(agentBrief, t('mcp.guide_copied'))}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold bg-theme-accent text-theme-bg hover:bg-theme-accent-hover transition-colors"
                >
                  <Copy className="w-4 h-4" />
                  {t('mcp.copy_agent_brief')}
                </button>
                <button
                  type="button"
                  onClick={() => copyGuide(guideMarkdown, t('mcp.guide_full_copied'))}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-theme-bg text-theme-text border border-theme-border hover:bg-theme-bg-hover transition-colors"
                >
                  <Copy className="w-4 h-4" />
                  {t('mcp.copy_guide')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
