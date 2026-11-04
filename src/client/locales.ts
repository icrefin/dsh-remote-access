/**
 * The panel's copy, in the two languages the shipped web client ships.
 *
 * `dshRemoteAccess` is this plugin's locale namespace: `ctx.locale.register`
 * publishes the dictionaries and `ctx.locale.bind` hands out a translate seat
 * bound to them. A locale revision re-renders every registered slot, so the
 * panel never caches a translated string.
 *
 * @module dsh-remote-access/client/locales
 */

/** English copy. */
export const en = {
  panel: 'Remote Access',
  title: 'Remote Access',
  description:
    'Reach this harness from your phone or another computer over a private mesh network such as Tailscale. '
    + 'The harness keeps listening on loopback; this plugin publishes one mesh address and asks for an access key.',
  credit: 'v{version} | Author: icrefin [icrefinai@gmail.com]',

  status: 'Status',
  listening: 'Listening',
  idle: 'Off',
  starting: 'Starting',
  failed: 'Not listening',

  address: 'Address',
  meshNetwork: 'Network',
  networkMesh: 'Private mesh',
  networkLan: 'Local network',
  networkAll: 'All interfaces',
  networkNone: 'No mesh interface found',
  upstream: 'Harness',
  boundSince: 'Since',

  enable: 'Enable mesh access',
  disable: 'Turn off',
  enabling: 'Working…',

  access: 'Remote access',
  accessHint: 'Open one of these links on a device in the same private network.',
  openHint: 'No access key is required. Anyone who can reach this port on the network gets the full agent.',
  noUrls: 'No address to advertise yet. Turn the listener on, or name a bind address below.',
  copy: 'Copy link',
  copied: 'Copied',
  showKey: 'Show key',
  hideKey: 'Hide key',
  regenerate: 'Replace key',
  regenerateConfirm: 'Replace the key? Every device that already unlocked will have to enter the new one.',
  keyRequired: 'Browser access key',
  keyRequiredHint: 'Optional hardening for a shared network. When it is on, every new browser must enter a key.',

  settings: 'Listener settings',
  port: 'Port',
  bindAddress: 'Bind address',
  bindAuto: 'Detected mesh address (recommended)',
  bindAll: 'All interfaces (0.0.0.0)',
  bindCustom: 'One address…',
  customPlaceholder: '100.x.y.z',
  apply: 'Apply',
  applying: 'Applying…',
  saved: 'Saved',
  notSaved: 'Applied, but not saved',
  saveFailed: 'Could not save the settings',

  noMeshTitle: 'No mesh interface is available',
  noMeshHint: 'Start Tailscale (or another overlay network) and this panel picks the address up within a minute.',

  allWarning:
    '0.0.0.0 accepts connections from every interface, including Wi-Fi and Ethernet. Use it only on a host whose network you control.',
  keyHint: 'The key is stored on this machine and shown only here.',

  retry: 'Refresh',
  loadFailed: 'The host refused the request',
  notSavedHint: 'This browser may have been unlocked with a key that no longer works.',
}

/** Simplified Chinese copy. Typed against `en`, so a missing key fails the build. */
export const zh: typeof en = {
  panel: 'Remote Access',
  title: 'Remote Access',
  description:
    '通过 Tailscale 等私有 mesh 网络，从手机或另一台电脑访问本机 Harness。'
    + 'Harness 本身仍只监听回环地址；本插件发布一个 mesh 地址，并要求输入访问密钥。',
  credit: 'v{version} | Author: icrefin [icrefinai@gmail.com]',

  status: '状态',
  listening: '正在监听',
  idle: '已关闭',
  starting: '正在启动',
  failed: '未监听',

  address: '地址',
  meshNetwork: '网络',
  networkMesh: '私有 mesh',
  networkLan: '局域网',
  networkAll: '所有接口',
  networkNone: '未发现 mesh 接口',
  upstream: 'Harness',
  boundSince: '启动于',

  enable: '启用 mesh 访问',
  disable: '关闭',
  enabling: '处理中…',

  access: '远程访问',
  accessHint: '在同一私有网络内的设备上打开以下链接。',
  openHint: '当前不要求访问密钥。网络内任何能访问该端口的设备都会获得完整的 agent 权限。',
  noUrls: '暂时没有可发布的地址。请先启用监听，或在下方指定绑定地址。',
  copy: '复制链接',
  copied: '已复制',
  showKey: '显示密钥',
  hideKey: '隐藏密钥',
  regenerate: '更换密钥',
  regenerateConfirm: '更换密钥？所有已解锁的设备都需要重新输入新密钥。',
  keyRequired: '浏览器访问密钥',
  keyRequiredHint: '共享网络中的可选加固。开启后，每个新浏览器都需要输入密钥。',

  settings: '监听设置',
  port: '端口',
  bindAddress: '绑定地址',
  bindAuto: '自动检测的 mesh 地址（推荐）',
  bindAll: '所有接口（0.0.0.0）',
  bindCustom: '指定一个地址…',
  customPlaceholder: '100.x.y.z',
  apply: '应用',
  applying: '正在应用…',
  saved: '已保存',
  notSaved: '已生效，但未保存',
  saveFailed: '设置未能保存',

  noMeshTitle: '没有可用的 mesh 接口',
  noMeshHint: '启动 Tailscale（或其他 overlay 网络）后，此面板会在一分钟内发现地址。',

  allWarning: '0.0.0.0 会接受来自所有接口（包括 Wi-Fi 与以太网）的连接。仅在你可控的网络中使用。',
  keyHint: '密钥保存在本机，仅在此处显示。',

  retry: '刷新',
  loadFailed: '主机拒绝了该请求',
  notSavedHint: '当前浏览器使用的密钥可能已经失效。',
}

/**
 * Translate one key of this panel's dictionary.
 *
 * The optional parameter bag feeds `{name}` placeholders — the version chip is
 * the one copy that needs it.
 */
export type PanelTranslate = (key: keyof typeof en, params?: Record<string, string | number>) => string