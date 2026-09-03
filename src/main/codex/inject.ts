/** Independent UI enhancement script for Codex (not copied from Codex++). */
export const CODEX_INJECTION_SOURCE = String.raw`
(() => {
  if (window.__dasuantouEnhanced) return;
  window.__dasuantouEnhanced = true;

  const dict = {
    'New thread': '新建对话',
    'New chat': '新建对话',
    'New conversation': '新建对话',
    'Start a new thread': '开始新对话',
    Settings: '设置',
    Plugins: '插件',
    Apps: '应用',
    Search: '搜索',
    Home: '主页',
    Local: '本地',
    Cloud: '云端',
    Archive: '归档',
    Archived: '已归档',
    Delete: '删除',
    Cancel: '取消',
    Confirm: '确认',
    Save: '保存',
    Close: '关闭',
    Open: '打开',
    Copy: '复制',
    Paste: '粘贴',
    Retry: '重试',
    Stop: '停止',
    Continue: '继续',
    Thinking: '思考中',
    'Working…': '处理中…',
    'Working...': '处理中...',
    Working: '处理中',
    'Ask Codex': '询问 Codex',
    'Ask anything': '随便问点什么',
    'Message Codex': '向 Codex 发消息',
    'Send a message': '发送消息',
    'What do you want to get done?': '你想完成什么？',
    Agent: '智能体',
    Agents: '智能体',
    Thread: '对话',
    Threads: '对话',
    Model: '模型',
    Models: '模型',
    Provider: '服务商',
    Connect: '连接',
    Disconnect: '断开',
    Login: '登录',
    Logout: '退出登录',
    'Sign in': '登录',
    'Sign out': '退出登录',
    Account: '账户',
    Profile: '个人资料',
    Help: '帮助',
    Docs: '文档',
    Documentation: '文档',
    Feedback: '反馈',
    Update: '更新',
    Updates: '更新',
    Version: '版本',
    About: '关于',
    General: '通用',
    Appearance: '外观',
    Theme: '主题',
    Language: '语言',
    Privacy: '隐私',
    Security: '安全',
    Advanced: '高级',
    Developer: '开发者',
    Experimental: '实验性',
    Enabled: '已启用',
    Disabled: '已禁用',
    Enable: '启用',
    Disable: '禁用',
    Install: '安装',
    Uninstall: '卸载',
    Download: '下载',
    Uploading: '上传中',
    Upload: '上传',
    File: '文件',
    Files: '文件',
    Folder: '文件夹',
    Project: '项目',
    Projects: '项目',
    Workspace: '工作区',
    Terminal: '终端',
    Diff: '差异',
    Review: '审查',
    Apply: '应用',
    Reject: '拒绝',
    Accept: '接受',
    Undo: '撤销',
    Redo: '重做',
    More: '更多',
    Less: '更少',
    Show: '显示',
    Hide: '隐藏',
    Expand: '展开',
    Collapse: '折叠',
    Today: '今天',
    Yesterday: '昨天',
    Earlier: '更早',
    Recent: '最近',
    Favorites: '收藏',
    Favorite: '收藏',
    Rename: '重命名',
    Share: '分享',
    Export: '导出',
    Import: '导入',
    Refresh: '刷新',
    Reload: '重新加载',
    Restart: '重启',
    Quit: '退出',
    Exit: '退出',
    'No results': '无结果',
    'Try again': '再试一次',
    'Something went wrong': '出错了',
    'Permission required': '需要权限',
    'Not installed': '未安装',
    'Coming soon': '即将推出',
    Upgrade: '升级',
    Usage: '用量',
    Limits: '限额',
    Queue: '队列',
    Queued: '排队中',
    Running: '运行中',
    Completed: '已完成',
    Failed: '失败',
    Pending: '等待中',
    Draft: '草稿',
    Preview: '预览',
    Code: '代码',
    Plan: '计划',
    Steps: '步骤',
    Tools: '工具',
    Tool: '工具',
    Skill: '技能',
    Skills: '技能',
    Plugin: '插件',
    Marketplace: '市场',
    'Browse plugins': '浏览插件',
    'Manage plugins': '管理插件',
    'Install plugin': '安装插件',
    'Open folder': '打开文件夹',
    'Open project': '打开项目',
    'Add files': '添加文件',
    'Attach files': '附加文件',
    'New project': '新建项目',
    'Light mode': '浅色模式',
    'Dark mode': '深色模式',
    'System default': '跟随系统',
    'Auto-approve': '自动批准',
    'Always ask': '每次询问',
    'Full access': '完全访问',
    Restricted: '受限',
    Sandbox: '沙箱',
    Network: '网络',
    Offline: '离线',
    Online: '在线',
    Connected: '已连接',
    Disconnected: '已断开',
    'Reasoning effort': '推理强度',
    Reasoning: '推理',
    Fast: '快速',
    Balanced: '均衡',
    Thorough: '深入',
    'ChatGPT account': 'ChatGPT 账号',
    'API key': 'API 密钥',
    'Sign in with ChatGPT': '使用 ChatGPT 登录',
    Environment: '环境',
    Permissions: '权限',
    Notifications: '通知',
    Keyboard: '键盘',
    Shortcuts: '快捷键'
  };

  const translateExact = (input) => {
    if (typeof input !== 'string' || !input) return input;
    const trimmed = input.trim();
    if (!trimmed || !dict[trimmed]) return input;
    return input.replace(trimmed, dict[trimmed]);
  };

  const shouldSkip = (node) => {
    if (!node || !node.parentElement) return true;
    return Boolean(
      node.parentElement.closest(
        'code,pre,textarea,input,kbd,script,style,[contenteditable="true"],[data-no-i18n]'
      )
    );
  };

  const unlock = () => {
    const keywords = /plugin|插件|apps?|应用|marketplace|市场|install|安装/i;
    for (const el of document.querySelectorAll(
      'button,[role="button"],a,[aria-disabled]'
    )) {
      const text =
        (el.textContent || '') +
        ' ' +
        (el.getAttribute('aria-label') || '') +
        ' ' +
        (el.getAttribute('title') || '');
      if (!keywords.test(text)) continue;
      el.removeAttribute('disabled');
      el.removeAttribute('aria-disabled');
      el.classList.remove('disabled', 'is-disabled');
      if (el instanceof HTMLElement) {
        el.style.pointerEvents = 'auto';
        el.style.opacity = '1';
      }
    }
  };

  const translateAttrs = (el) => {
    for (const attr of ['placeholder', 'aria-label', 'title']) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const next = translateExact(value);
      if (next !== value) el.setAttribute(attr, next);
    }
  };

  let applying = false;
  const walk = (root) => {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      if (shouldSkip(root)) return;
      const next = translateExact(root.nodeValue || '');
      if (next !== root.nodeValue) root.nodeValue = next;
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.childElementCount === 0) translateAttrs(root);
    if (root.shadowRoot) walk(root.shadowRoot);
    for (const child of Array.from(root.childNodes || [])) walk(child);
  };

  document.addEventListener(
    'paste',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.isContentEditable) return;
      const text = event.clipboardData && event.clipboardData.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      document.execCommand('insertText', false, text);
    },
    true
  );

  const apply = () => {
    if (applying) return;
    applying = true;
    try {
      unlock();
      walk(document.body || document.documentElement);
    } catch (error) {
      window.__dasuantouLastError = String(error);
    } finally {
      applying = false;
    }
  };

  const observer = new MutationObserver(() => {
    if (applying) return;
    apply();
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'placeholder', 'aria-label', 'title']
  });
  apply();
  setInterval(apply, 2000);
})();
`
