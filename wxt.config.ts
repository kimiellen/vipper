import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'vipper',
    description: '标签管理器 + 书签/密码管理器（Hyprland 风格二维导航）',
    permissions: ['tabs', 'tabGroups', 'storage', 'unlimitedStorage', 'favicon', 'alarms', 'scripting'],
    host_permissions: ['<all_urls>'],
    commands: {
      'group-prev': {
        suggested_key: { default: 'Alt+Up' },
        description: '切换到上一个标签组',
      },
      'group-next': {
        suggested_key: { default: 'Alt+Down' },
        description: '切换到下一个标签组',
      },
      'tab-prev': {
        suggested_key: { default: 'Alt+Shift+Left' },
        description: '组内切换到左侧标签',
      },
      'tab-next': {
        suggested_key: { default: 'Alt+Shift+Right' },
        description: '组内切换到右侧标签',
      },
      // suggested_key 上限 4 个已用满，以下命令需用户在 chrome://extensions/shortcuts 手动绑定
      'open-launcher': {
        description: '打开书签管理器',
      },
      'autofill': {
        description: '在当前登录页填充账号密码（建议绑定 Alt+P）',
      },
    },
  },
});
