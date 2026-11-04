# dsh-remote-access

用手机、平板或另一台电脑，通过**私有网格网络**——Tailscale、ZeroTier、NetBird——访问这台
DeepSeek Harness，拿到真正的 Harness 客户端，而不是删减过的远程控制工具。一个开关，一条链接。

**简体中文** | [English](README.md)

[![License](https://img.shields.io/github/license/icrefin/dsh-remote-access?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/icrefin/dsh-remote-access?style=flat-square)](https://github.com/icrefin/dsh-remote-access/releases/tag/v0.1.2)
[![CI](https://img.shields.io/github/actions/workflow/status/icrefin/dsh-remote-access/ci.yml?branch=main&style=flat-square)](https://github.com/icrefin/dsh-remote-access/actions/workflows/ci.yml)
[![Last commit](https://img.shields.io/github/last-commit/icrefin/dsh-remote-access?style=flat-square)](https://github.com/icrefin/dsh-remote-access/commits/main)
[![Stars](https://img.shields.io/github/stars/icrefin/dsh-remote-access?style=flat-square)](https://github.com/icrefin/dsh-remote-access/stargazers)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](https://github.com/icrefin/dsh-remote-access/pulls)
[![Node](https://img.shields.io/badge/node-%3E%3D22.17-339933?style=flat-square&logo=node.js)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.5-4B5563?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

```
设置/侧边栏 ▸ Remote Access
└── 监听状态 · 可直接打开的链接 · 绑定地址 · 可选访问密钥
```

## 为什么做成网关，而不是直接换绑定地址

`dsh web` 有意拒绝通配绑定：`--host` 只接受一个具体的本机地址，`0.0.0.0` 在启动时就会被拒绝。
桌面应用更进一步——它以 `--host 127.0.0.1 --port 0` 启动 harness，因此在任何插件加载之前，
Web 服务器就已经绑定在回环地址的一个随机端口上。没有任何配置能把那个监听器变成网络监听器。

所以这个插件的形态是网关：

```
 手机 / 笔记本                     本机
┌──────────────┐   WireGuard   ┌─────────────────────────────┐
│ 浏览器       │──────────────▶│ 100.x.y.z:3080              │
│（真实 DSH UI）│               │  └─ 密钥校验 → 转发 ──┐     │
└──────────────┘               │                       ▼     │
                               │   127.0.0.1:<随机端口>  harness│
                               │   （不变，仅回环）            │
                               └─────────────────────────────┘
```

浏览器加载的页面和本地窗口加载的完全一样，因此会话、提示、流式输出、终端和设置从构造上就都在。
网关对每个请求只做这些事：检查自己的 cookie，附上它为自己领到的 harness cookie，把 `Host`
改写成回环地址，丢弃 `Origin`/`Referer`/`Sec-Fetch-*`，再把应答流式送回去。WebSocket 升级按原始
套接字转发。

由于网格传输本身已由 WireGuard 加密，网关在 `3080` 上提供明文 HTTP；它从不假装终止 TLS。

## 安装

```sh
pnpm install
pnpm check        # 两半都做类型检查、构建、运行 85 个测试
pnpm run pack     # -> dist/dsh-remote-access-0.1.2.tgz
scripts/install.sh
```

在 **Settings → Plugins** 中安装打包好的 tarball，然后**重启**应用。加到运行中 profile 里的
bundle 要等到下一次启动才能被导入。

监听器出厂为**关闭**状态。安装插件不会暴露任何东西，直到你打开它。

## 使用

1. 打开侧边栏的 **Remote Access** 行。
2. 按 **启用 mesh 访问**。面板会绑定检测到的网格地址，并显示一条或多条链接。
3. 在同一网格内的设备上打开链接。不会询问密钥：私有网络本身就是访问边界，你在 Tailscale
   （或 ZeroTier、NetBird）里已经管理的成员关系就是授权。
4. 可选：当网络是共享的时，打开 **浏览器访问密钥**。之后每个新浏览器都要输入一次密钥，
   而 **更换密钥** 会让它们全部失效。

如果主机上运行着 Tailscale，第一条链接使用 MagicDNS 名称（`http://host.tailnet.ts.net:3080/`），
它能在地址变化后继续可用。点分地址会列在旁边。

## 它贡献了什么

| 接口 | 作用 |
|---|---|
| 主机路由 `GET /api/dsh-remote-access/status` | 监听状态、检测到的网卡、绑定错误 |
| 主机路由 `POST /api/dsh-remote-access/config` | 实时设置，经设置服务持久化 |
| 主机路由 `GET /api/dsh-remote-access/key` | 链接（明文，或开启密钥后带密钥） |
| 主机路由 `POST /api/dsh-remote-access/regenerate` | 更换密钥，并使所有 cookie 失效 |
| 网关 `http://<mesh-address>:3080/` | 可选密钥校验，然后在回环上转发 harness |
| 侧边栏 **Remote Access** 行 | 驱动上述一切的面板 |

## 安全模型

- **默认关闭。** 没有人启用它，就不会绑定任何端口。
- **私有网络就是边界。** 这个插件面向成员关系由你掌控的网格，因此默认不要求密钥：任何能
  访问该端口的设备都能拿到 agent。请用网络 ACL 把 3080 端口限制在信任的设备上。
- **密钥可用，且为可选。** 对共享 tailnet，开启 **浏览器访问密钥**：32 个随机字节存放在
  `$DSH_HOME/remote-access/key`（权限 `0600`），浏览器只持有 HMAC cookie，harness 的启动令牌
  和会话 cookie 从不离开主机。
- **默认只绑定一个具体地址。** 优先选择检测到的 `100.64.0.0/10` 网格地址而不是局域网，
  这样在咖啡馆 Wi-Fi 上的笔记本不会把 agent 发布到咖啡馆。面板里可以选择 `0.0.0.0`
  并给出警告，供你确实掌控机器加入的每个网络时使用。
- **暴力破解有速率限制。** 开启密钥时，每个客户端每 15 分钟允许 8 次错误。
- **网格段上是明文 HTTP。** 传输加密由 WireGuard 提供，网关不增加 TLS。不要把端口经
  Tailscale Funnel 暴露出去，并用 tailnet ACL 把 3080 限制在信任设备。
- **吊销是显式的。** 从网络 ACL 中移除设备，或在开启密钥时更换密钥。没有按设备区分的密钥列表。

## 设置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 监听器是否应当运行 |
| `port` | `3080` | 网格地址上的 TCP 端口 |
| `bindHost` | `auto` | `auto`（自动检测的网格网卡）、`all`（`0.0.0.0`），或一个 IPv4 字面量 |
| `requireKey` | `false` | 可选加固：浏览器是否必须先出示密钥 |

面板通过 harness 的**设置服务**写入这些值，因此值会落到 profile 的 `cordis.patch.yml`，
并在重启后保留。无法持久化的写入仍会生效，并报告为 *已生效，但未保存*。

## Tailscale 说明

- 插件不内嵌 Tailscale。它检测 `100.64.0.0/10` 范围内的地址（Tailscale、ZeroTier 和 NetBird
  使用的范围），并在安装了 CLI 时通过 `tailscale status --json` 询问节点的 MagicDNS 名称。
  只有 GUI、没有 CLI 符号链接的安装仍然可用，只是使用 IP 链接。
- 在 tailnet ACL 中限制端口，例如：

  ```json
  { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:my-mac:3080"] }
  ```

- Funnel 会发布到公网，不是这个插件的用途。

## 限制

- Harness 必须正在运行；网关活在它的进程里。机器睡眠会结束远程访问。
- 网关每个进程代理一个 harness 实例（当前 profile）。
- 不做 TLS 终止，也不管理证书。
- 网格地址不受局域网变化影响，但 Tailscale 重新登录可能改变它；面板会在一分钟内重新绑定。

## 开发

```sh
pnpm check                              # 两半类型检查、构建，然后 vitest
scripts/install.sh                      # 打包到 dist/ 并打印安装路径
scripts/dev-profile.sh boot 19599       # 在 :19599 的隔离 profile 中启动
scripts/dev-profile.sh remove
```

`test/gateway.spec.ts` 是最重要的一个：一个真实的 HTTP 服务器代替 harness（它检查 `Host`、
拒绝 `Origin`、要求自己的会话 cookie），网关通过 `fetch` 和原始 WebSocket 握手做端到端驱动。

## 目录结构

| 路径 | 作用 |
|---|---|
| `src/index.ts` | 主机半：Config、网关生命周期、路由注册 |
| `src/mesh/gateway.ts` | 监听器、密钥校验、HTTP 转发、WebSocket 隧道 |
| `src/mesh/gate.ts` | cookie 签名、解锁页、失败限流 |
| `src/mesh/detect.ts` | 网卡分类器与 Tailscale 读取 |
| `src/mesh/secret.ts` | 密钥文件 |
| `src/routes.ts` | 面板的路由族 |
| `src/client/` | 浏览器半：侧边栏行、页面、词典、样式 |
| `cordis.patch.yml` | 插入 Loader 行的 bundle patch |

## 贡献

欢迎提交 issue 和 pull request——bug 表单会询问访问链路的哪一步坏了，通常足以复现。
[CONTRIBUTING.md](.github/CONTRIBUTING.md) 里有命令和每个 spec 锁定的内容。漏洞请通过
[SECURITY.md](.github/SECURITY.md) 报告，不要开公开 issue。本项目遵循[贡献者公约](.github/CODE_OF_CONDUCT.md)。

> 如果从手机远程访问省下了你走到桌面的那几步，一颗 ⭐ 能帮其他 DSH 用户找到它。

## 许可证

MIT——见 [LICENSE](LICENSE)。