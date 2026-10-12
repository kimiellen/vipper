import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'vipper',
    description: '标签管理器 + 书签/密码管理器（Hyprland 风格二维导航）',
    permissions: ['tabs', 'tabGroups', 'storage'],
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
    },
  },
});
