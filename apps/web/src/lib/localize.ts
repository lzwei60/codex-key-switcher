export type LocalizeText = (zh: string, en: string) => string;

export function localizeRuntimeMessage(value: string, text: LocalizeText): string {
  const message = value.trim();
  if (!message) return message;

  const exact: Record<string, [string, string]> = {
    '配置不存在。': ['配置不存在。', 'Configuration not found.'],
    '模型不存在，无法切换。': ['模型不存在，无法切换。', 'Model not found; it cannot be selected.'],
    '未选择供应商': ['未选择供应商', 'No provider selected'],
    '操作失败': ['操作失败', 'Operation failed'],
    '桌面 API 未连接，当前为 Web 预览模式。': ['桌面 API 未连接，当前为 Web 预览模式。', 'The desktop API is unavailable. Web preview mode is active.'],
    '桌面 API 未连接，当前 Web 预览模式不能检查更新。': ['桌面 API 未连接，当前 Web 预览模式不能检查更新。', 'Updates cannot be checked while the desktop API is unavailable in web preview mode.'],
    '桌面 API 未连接，当前 Web 预览模式不能检测模型连通性。': ['桌面 API 未连接，当前 Web 预览模式不能检测模型连通性。', 'Model connectivity cannot be checked while the desktop API is unavailable in web preview mode.'],
    '桌面 API 未连接，当前 Web 预览模式不能拉取上游模型列表。': ['桌面 API 未连接，当前 Web 预览模式不能拉取上游模型列表。', 'Upstream models cannot be fetched while the desktop API is unavailable in web preview mode.'],
    '上游没有返回可识别的模型列表。': ['上游没有返回可识别的模型列表。', 'The upstream service returned no recognizable models.'],
    'Base URL 不是有效地址。': ['Base URL 不是有效地址。', 'The base URL is not valid.'],
    'Base URL 只支持 http/https 地址。': ['Base URL 只支持 http/https 地址。', 'The base URL must use http or https.'],
    '至少添加一个模型。': ['至少添加一个模型。', 'Add at least one model.'],
    '请先填写 API Key，编辑已有配置时也需要本地已保存 Key。': ['请先填写 API Key，编辑已有配置时也需要本地已保存 Key。', 'Enter an API key first. Editing an existing provider also requires a locally saved key.'],
    '端口范围必须在 1024 到 65535 之间。': ['端口范围必须在 1024 到 65535 之间。', 'The port must be between 1024 and 65535.'],
    '检测超时，上游 20 秒内未响应。': ['检测超时，上游 20 秒内未响应。', 'The check timed out because the upstream service did not respond within 20 seconds.'],
    '拉取超时，上游 20 秒内未响应。': ['拉取超时，上游 20 秒内未响应。', 'Fetching timed out because the upstream service did not respond within 20 seconds.'],
    '模型检测请求失败。': ['模型检测请求失败。', 'The model check request failed.'],
    '拉取上游模型列表失败。': ['拉取上游模型列表失败。', 'Failed to fetch the upstream model list.'],
    '直连供应商模式仅支持 Responses 格式供应商；当前配置请先切换到本地路由模式，或保持 Responses 格式。': ['直连供应商模式仅支持 Responses 格式供应商；当前配置请先切换到本地路由模式，或保持 Responses 格式。', 'Direct provider mode supports Responses providers only. Switch to local gateway mode or keep the Responses format.'],
    '直连供应商模式仅支持 Responses 格式供应商；Chat Completions 和 Anthropic 请使用本地路由模式。': ['直连供应商模式仅支持 Responses 格式供应商；Chat Completions 和 Anthropic 请使用本地路由模式。', 'Direct provider mode supports Responses providers only. Use local gateway mode for Chat Completions and Anthropic.'],
    '当前供应商缺少本地 API Key，无法启用直连供应商模式。': ['当前供应商缺少本地 API Key，无法启用直连供应商模式。', 'The current provider has no locally saved API key, so direct provider mode cannot be enabled.'],
    '请先添加并选择一个供应商，再启用直连供应商模式。': ['请先添加并选择一个供应商，再启用直连供应商模式。', 'Add and select a provider before enabling direct provider mode.'],
    '切换连接模式后需要重启 Codex。': ['切换连接模式后需要重启 Codex。', 'Restart Codex after switching the connection mode.'],
    '连接服务已停止，但 Codex 配置恢复失败。': ['连接服务已停止，但 Codex 配置恢复失败。', 'The connection service stopped, but the Codex configuration could not be restored.'],
    '连接服务已停止，Codex 配置已恢复。': ['连接服务已停止，Codex 配置已恢复。', 'The connection service stopped and the Codex configuration was restored.'],
    '连接服务已停止，Codex 配置无需恢复。': ['连接服务已停止，Codex 配置无需恢复。', 'The connection service stopped; no Codex configuration restore was needed.'],
    '未找到恢复脚本。': ['未找到恢复脚本。', 'The restore script was not found.'],
  };
  const known = exact[message];
  if (known) return text(known[0], known[1]);

  const imported = message.match(/^已导入 (\d+) 个供应商配置$/);
  if (imported) return text(message, `${imported[1]} provider configuration(s) imported`);

  const fetched = message.match(/^已拉取 (\d+) 个上游模型。$/);
  if (fetched) return text(message, `Fetched ${fetched[1]} upstream model(s).`);

  const checked = message.match(/^模型 (.+) 连通性检测通过。$/);
  if (checked) return text(message, `Model ${checked[1]} connectivity check passed.`);

  const upstreamStatus = message.match(/^上游返回 (\d+)：(.+)$/);
  if (upstreamStatus) return text(message, `Upstream returned ${upstreamStatus[1]}: ${upstreamStatus[2]}`);

  const duplicateAlias = message.match(/^模型自定义名称重复：(.+)$/);
  if (duplicateAlias) return text(message, `Duplicate model alias: ${duplicateAlias[1]}`);

  const portAvailable = message.match(/^端口 (\d+) 可用。$/);
  if (portAvailable) return text(message, `Port ${portAvailable[1]} is available.`);

  const portBusy = message.match(/^端口 (\d+) 已被占用。$/);
  if (portBusy) return text(message, `Port ${portBusy[1]} is already in use.`);

  return message;
}

export function localizeHealthStatus(value: string, text: LocalizeText): string {
  const health = value.trim();
  const status: Record<string, [string, string]> = {
    '正常 · 直连供应商': ['正常 · 直连供应商', 'Healthy · Direct provider'],
    '正常 · 运行正常': ['正常 · 运行正常', 'Healthy · Running normally'],
    '警告 · 代理未运行': ['警告 · 代理未运行', 'Warning · Gateway is not running'],
    '正常 · 配置可恢复': ['正常 · 配置可恢复', 'Healthy · Configuration can be restored'],
    '警告 · 需要检查配置': ['警告 · 需要检查配置', 'Warning · Configuration needs review'],
    '警告 · 浏览器预览模式': ['警告 · 浏览器预览模式', 'Warning · Browser preview mode'],
  };
  const localized = status[health];
  return localized ? text(localized[0], localized[1]) : health;
}
