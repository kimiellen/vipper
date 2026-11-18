import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'vipper',
    description: '标签管理器 + 书签/密码管理器（键盘二维导航）',
    // M40：钉固定公钥使扩展 ID 恒定（dmgfibpimmkihmkcdjhjnpnjbfobfbhn），
    // Native Messaging manifest 的 allowed_origins 依此固定（socket-access.md §10.1）。
    // 私钥不留存：zip 分发不需要 crx 签名。
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr1aUQouEUOQwec83tl0gNKEMxTmpdHaSoz8u1ic2DtN6nta/wmsV4w0AVB44udWUq06vnOx/0RjhsdM0bWkc0i5Ej6DPvpKodgXyjHwRsjQfJNxFv5ScZU8zQKs8+CIaYtdcR+SZKZQi5Xim++d8YJb1XJqKGZeyMfXgC7GHuCTWjlbgAPAsuENgumUt8Ot1YRajyHfQD5hiG11BvpjA0gp9T9iwHjwIVg2/me/mrZYNxuVizYp7u8FF1o3hBqNTM3WUB7tHoHD7u9xhxktG7zWIuPJdbKH0JA1z9Hu8cyVQltWDZrbEk36HEkUFuKeRBB3ftrouMY/CWd2OEA1CyQIDAQAB',
    // socket-access.md §10.4：WebCrypto X25519 底线
    minimum_chrome_version: '133',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    permissions: ['tabs', 'tabGroups', 'storage', 'unlimitedStorage', 'favicon', 'alarms', 'scripting', 'system.display', 'bookmarks', 'nativeMessaging'],
    host_permissions: ['<all_urls>'],
    commands: {
      'group-prev': {
        suggested_key: { default: 'Alt+H' },
        description: '切换到上一个标签组',
      },
      'group-next': {
        suggested_key: { default: 'Alt+L' },
        description: '切换到下一个标签组',
      },
      'tab-prev': {
        suggested_key: { default: 'Alt+J' },
        description: '组内切换到左侧标签',
      },
      'tab-next': {
        suggested_key: { default: 'Alt+K' },
        description: '组内切换到右侧标签',
      },
      // suggested_key 上限 4 个已用满，以下命令需用户在 chrome://extensions/shortcuts 手动绑定
      'open-launcher': {
        description: '打开书签管理器',
      },
      'open-groups': {
        description: '打开标签组管理页（建议绑定 Alt+,）',
      },
      'autofill': {
        description: '在当前登录页填充账号密码（建议绑定 Alt+P）',
      },
    },
  },
});
