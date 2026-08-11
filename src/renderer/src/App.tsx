import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppId,
  AppInfo,
  ApplyResult,
  Provider,
  SpeedTestResult
} from '../../shared/types'

type FormState = {
  name: string
  endpoint: string
  apiKey: string
  model: string
  vendor: string
  supportsToolCall: boolean
  supportsImages: boolean
  supportsReasoning: boolean
}

const emptyForm = (): FormState => ({
  name: '大算头',
  endpoint: 'http://ai.i-shadowclub.com',
  apiKey: '',
  model: '',
  vendor: 'dst',
  supportsToolCall: true,
  supportsImages: false,
  supportsReasoning: false
})

export default function App() {
  const [apps, setApps] = useState<AppInfo[]>([])
  const [currentApp, setCurrentApp] = useState<AppId>('workbuddy')
  const [providers, setProviders] = useState<Provider[]>([])
  const [dataDir, setDataDir] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [busy, setBusy] = useState(false)
  const [fetchingModels, setFetchingModels] = useState(false)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [modelFilter, setModelFilter] = useState('')
  const [toast, setToast] = useState<{
    text: string
    error?: boolean
  } | null>(null)

  const currentMeta = useMemo(
    () => apps.find((a) => a.id === currentApp),
    [apps, currentApp]
  )

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error })
    window.setTimeout(() => setToast(null), 3200)
  }, [])

  const refresh = useCallback(async () => {
    const [appList, providerList, dir] = await Promise.all([
      window.dst.listApps(),
      window.dst.listProviders(currentApp),
      window.dst.getDataDir()
    ])
    setApps(appList)
    setProviders(providerList)
    setDataDir(dir)
  }, [currentApp])

  useEffect(() => {
    refresh().catch((err) =>
      showToast(err instanceof Error ? err.message : String(err), true)
    )
  }, [refresh, showToast])

  useEffect(() => {
    return window.dst.onDeepLinkImported(() => {
      refresh()
      showToast('已通过 Deep Link 导入 Provider')
    })
  }, [refresh, showToast])

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm())
    setModelOptions([])
    setShowModelPicker(false)
    setModelFilter('')
    setShowForm(true)
  }

  const openEdit = (p: Provider) => {
    setEditing(p)
    setForm({
      name: p.name,
      endpoint: p.endpoint,
      apiKey: p.apiKey,
      model: p.model,
      vendor: p.vendor || 'dst',
      supportsToolCall: p.supportsToolCall ?? true,
      supportsImages: p.supportsImages ?? false,
      supportsReasoning: p.supportsReasoning ?? false
    })
    setModelOptions([])
    setShowModelPicker(false)
    setModelFilter('')
    setShowForm(true)
  }

  const onFetchModels = async () => {
    if (!form.endpoint.trim()) {
      showToast('请先填写 Endpoint', true)
      return
    }
    if (!form.apiKey.trim()) {
      showToast('请先填写 API Key', true)
      return
    }
    setFetchingModels(true)
    try {
      const result = await window.dst.fetchModels(form.endpoint, form.apiKey)
      if (!result.ok) {
        showToast(result.error || '获取模型失败', true)
        return
      }
      if (!result.models.length) {
        showToast('未获取到模型列表', true)
        return
      }
      setModelOptions(result.models)
      setShowModelPicker(true)
      setModelFilter('')
      showToast(`已获取 ${result.models.length} 个模型`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setFetchingModels(false)
    }
  }

  const filteredModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase()
    if (!q) return modelOptions
    return modelOptions.filter((m) => m.toLowerCase().includes(q))
  }, [modelOptions, modelFilter])

  const saveForm = async () => {
    if (!form.name.trim() || !form.endpoint.trim() || !form.apiKey.trim()) {
      showToast('请填写名称、Endpoint 和 API Key', true)
      return
    }
    if (!form.model.trim()) {
      showToast('请填写模型 ID', true)
      return
    }
    setBusy(true)
    try {
      if (editing) {
        await window.dst.updateProvider(editing.id, {
          name: form.name.trim(),
          endpoint: form.endpoint.trim(),
          apiKey: form.apiKey.trim(),
          model: form.model.trim(),
          vendor: form.vendor.trim() || 'dst',
          supportsToolCall: form.supportsToolCall,
          supportsImages: form.supportsImages,
          supportsReasoning: form.supportsReasoning
        })
        showToast('已更新 Provider')
      } else {
        await window.dst.createProvider({
          name: form.name.trim(),
          app: currentApp,
          endpoint: form.endpoint.trim(),
          apiKey: form.apiKey.trim(),
          model: form.model.trim(),
          vendor: form.vendor.trim() || 'dst',
          supportsToolCall: form.supportsToolCall,
          supportsImages: form.supportsImages,
          supportsReasoning: form.supportsReasoning
        })
        showToast('已添加 Provider')
      }
      setShowForm(false)
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  const onEnable = async (id: string) => {
    setBusy(true)
    try {
      const result: ApplyResult = await window.dst.enableProvider(id)
      showToast(result.message, !result.ok)
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (id: string) => {
    setBusy(true)
    try {
      await window.dst.deleteProvider(id)
      showToast('已删除')
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  const onSpeedTest = async (p: Provider) => {
    setBusy(true)
    try {
      const result: SpeedTestResult = await window.dst.speedTest(
        p.endpoint,
        p.apiKey
      )
      if (result.ok) {
        const sample = result.modelsSample?.length
          ? `；模型示例：${result.modelsSample.join(', ')}`
          : ''
        showToast(`测速成功 ${result.latencyMs}ms${sample}`)
      } else {
        showToast(
          `测速失败${result.latencyMs ? ` ${result.latencyMs}ms` : ''}：${result.error || result.status}`,
          true
        )
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  const onLaunch = async () => {
    setBusy(true)
    try {
      await window.dst.launchApp(currentApp)
      showToast('已尝试启动应用')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>大算头适配器</strong>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => refresh()} disabled={busy}>
            刷新
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <h3>应用</h3>
          <div className="sidebar-apps">
            {apps.map((app) => (
              <button
                key={app.id}
                className={`app-item ${currentApp === app.id ? 'active' : ''}`}
                onClick={() => setCurrentApp(app.id)}
              >
                <div>{app.name}</div>
                <div className="meta">
                  {app.implemented ? (
                    <span className={`badge ${app.installed ? 'ok' : 'warn'}`}>
                      {app.installed ? '已安装' : '未检测到'}
                    </span>
                  ) : (
                    <span className="badge">框架占位</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </aside>

        <main className="panel">
          <div className="panel-head">
            <div>
              <h2>{currentMeta?.name || currentApp}</h2>
              <div className="sub" style={{ color: 'var(--muted)', fontSize: 12 }}>
                {currentMeta?.implemented
                  ? currentMeta.configPath || currentMeta.message
                  : '适配器框架已预留，写入逻辑尚未实现'}
              </div>
            </div>
            <div className="actions">
              {currentMeta?.implemented && (
                <button className="btn" onClick={onLaunch} disabled={busy}>
                  启动
                </button>
              )}
            </div>
          </div>

          {currentMeta?.implemented && (
            <div className="add-provider-wrap">
              <button
                className="btn primary"
                onClick={openCreate}
                disabled={busy}
              >
                添加 Provider
              </button>
            </div>
          )}

          <div className="panel-body">
            {!currentMeta?.implemented ? (
              <div className="empty">
                {currentMeta?.name} 仅搭建框架，启用写入将在后续版本实现。
              </div>
            ) : providers.length === 0 ? (
              <div className="empty">
                还没有 Provider。添加任意服务商的 Endpoint + API Key，然后点「启用」写入
                WorkBuddy。
              </div>
            ) : (
              <div className="list">
                {providers.map((p) => (
                  <div
                    key={p.id}
                    className={`card ${p.enabled ? 'enabled' : ''}`}
                  >
                    <div>
                      <h4>
                        {p.name}{' '}
                        {p.enabled && <span className="badge ok">当前启用</span>}
                      </h4>
                      <div className="sub">模型：{p.model}</div>
                      <div className="sub">Endpoint：{p.endpoint}</div>
                      <div className="row">
                        <button
                          className="btn primary"
                          disabled={busy || p.enabled}
                          onClick={() => onEnable(p.id)}
                        >
                          启用
                        </button>
                        <button
                          className="btn"
                          disabled={busy}
                          onClick={() => onSpeedTest(p)}
                        >
                          测速
                        </button>
                        <button
                          className="btn"
                          disabled={busy}
                          onClick={() => openEdit(p)}
                        >
                          编辑
                        </button>
                        <button
                          className="btn danger"
                          disabled={busy || p.enabled}
                          onClick={() => onDelete(p.id)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="footer-note">
            本地数据目录：{dataDir || '...'}（备份在 backups/ 下）。任意 HTTP
            服务商均可添加，不绑定特定中转站。
          </p>
        </main>
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editing ? '编辑 Provider' : '添加 Provider'}</h3>
            <div className="form">
              <div className="field">
                <label>名称</label>
                <input
                  value={form.name}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, name: e.target.value }))
                  }
                  placeholder="例如：我的网关"
                />
              </div>
              <div className="field">
                <label>Endpoint（Base URL 或完整 chat/completions URL）</label>
                <input
                  value={form.endpoint}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, endpoint: e.target.value }))
                  }
                  placeholder="https://api.example.com 或 .../v1/chat/completions"
                />
              </div>
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, apiKey: e.target.value }))
                  }
                  placeholder="sk-..."
                />
              </div>
              <div className="field">
                <label>模型 ID</label>
                <div className="field-row">
                  <input
                    value={form.model}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, model: e.target.value }))
                    }
                    placeholder="写入 WorkBuddy models.json 的 id"
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || fetchingModels}
                    onClick={onFetchModels}
                  >
                    {fetchingModels ? '获取中…' : '选择'}
                  </button>
                </div>
                {showModelPicker && (
                  <div className="model-picker">
                    <input
                      className="model-filter"
                      value={modelFilter}
                      onChange={(e) => setModelFilter(e.target.value)}
                      placeholder="搜索模型…"
                    />
                    <div className="model-picker-list">
                      {filteredModels.length === 0 ? (
                        <div className="model-picker-empty">无匹配模型</div>
                      ) : (
                        filteredModels.map((id) => (
                          <button
                            key={id}
                            type="button"
                            className={`model-option ${form.model === id ? 'active' : ''}`}
                            onClick={() => {
                              setForm((s) => ({ ...s, model: id }))
                              setShowModelPicker(false)
                            }}
                          >
                            {id}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="field">
                <label>Vendor</label>
                <input
                  value={form.vendor}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, vendor: e.target.value }))
                  }
                  placeholder="dst"
                />
              </div>
              <div className="checks">
                <label>
                  <input
                    type="checkbox"
                    checked={form.supportsToolCall}
                    onChange={(e) =>
                      setForm((s) => ({
                        ...s,
                        supportsToolCall: e.target.checked
                      }))
                    }
                  />{' '}
                  Tool Call
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={form.supportsImages}
                    onChange={(e) =>
                      setForm((s) => ({
                        ...s,
                        supportsImages: e.target.checked
                      }))
                    }
                  />{' '}
                  Images
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={form.supportsReasoning}
                    onChange={(e) =>
                      setForm((s) => ({
                        ...s,
                        supportsReasoning: e.target.checked
                      }))
                    }
                  />{' '}
                  Reasoning
                </label>
              </div>
              <div className="actions">
                <button className="btn" onClick={() => setShowForm(false)}>
                  取消
                </button>
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={saveForm}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`}>{toast.text}</div>
      )}
    </div>
  )
}
