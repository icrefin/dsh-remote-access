# dsh-remote-access

Reach this DeepSeek Harness from your phone, tablet, or another computer over a
**private mesh network** — Tailscale, ZeroTier, NetBird — and get the real
Harness client, not a cut-down remote control. One switch, one link.

**English** | [简体中文](README.zh-CN.md)

[![License](https://img.shields.io/github/license/icrefin/dsh-remote-access?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/icrefin/dsh-remote-access?style=flat-square)](https://github.com/icrefin/dsh-remote-access/releases/tag/v0.1.2)
[![CI](https://img.shields.io/github/actions/workflow/status/icrefin/dsh-remote-access/ci.yml?branch=main&style=flat-square)](https://github.com/icrefin/dsh-remote-access/actions/workflows/ci.yml)
[![Last commit](https://img.shields.io/github/last-commit/icrefin/dsh-remote-access?style=flat-square)](https://github.com/icrefin/dsh-remote-access/commits/main)
[![Stars](https://img.shields.io/github/stars/icrefin/dsh-remote-access?style=flat-square)](https://github.com/icrefin/dsh-remote-access/stargazers)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](https://github.com/icrefin/dsh-remote-access/pulls)
[![Node](https://img.shields.io/badge/node-%3E%3D22.17-339933?style=flat-square&logo=node.js)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.5-4B5563?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

```
Settings/Sidebar ▸ Remote Access
└── listener status · ready-to-open links · bind address · optional key
```

## Why a gateway, and not just a rebind

`dsh web` deliberately refuses a wildcard bind: `--host` takes one concrete local
address, and `0.0.0.0` is rejected at startup. The desktop app goes further — it
launches the harness as `--host 127.0.0.1 --port 0`, so the web server is bound
to loopback on a random port before any plugin loads. There is no configuration
that turns that listener into a network one.

So this plugin is a gateway instead:

```
 phone / laptop                    this machine
┌──────────────┐   WireGuard   ┌─────────────────────────────┐
│ browser      │──────────────▶│ 100.x.y.z:3080              │
│ (real DSH UI)│               │  └─ key gate → replay ──┐   │
└──────────────┘               │                          ▼  │
                               │   127.0.0.1:<random>  harness│
                               │   (unchanged, loopback only)  │
                               └─────────────────────────────┘
```

The browser loads the same page the local window loads, so sessions, prompts,
streaming, terminal and settings all arrive by construction. The only work the
gateway does per request is: check its own cookie, attach the harness cookie it
minted for itself, rewrite `Host` to loopback, drop `Origin`/`Referer`/`Sec-Fetch-*`,
and stream the answer back. WebSocket upgrades are tunnelled as raw sockets.

Because the mesh transport is already WireGuard-encrypted, the gateway serves
plain HTTP on `3080`; it never pretends to terminate TLS.

## Install

```sh
pnpm install
pnpm check        # typecheck both halves, build, run 85 tests
pnpm run pack     # -> dist/dsh-remote-access-0.1.2.tgz
scripts/install.sh
```

Install the packed tarball from **Settings → Plugins**, then **restart** the app.
A bundle added to a running profile cannot be imported until the next start.

The listener ships **off**. Installing the plugin exposes nothing until you turn
it on.

## Use

1. Open the sidebar row **Remote Access**.
2. Press **Enable mesh access**. The panel binds the detected mesh address and
   shows one or more links.
3. Open a link on a device in the same mesh. No key is asked for: the private
   network is the access boundary, and the membership you already manage in
   Tailscale (or ZeroTier, or NetBird) is the authorization.
4. Optional: switch **Browser access key** on when the network is shared. Then
   every new browser enters a key once, and **Replace key** revokes them all.

If the host has Tailscale running, the first link uses the MagicDNS name
(`http://host.tailnet.ts.net:3080/`), which survives an address change. The
dotted address is listed next to it.

## What it contributes

| Surface | What it does |
|---|---|
| Host route `GET /api/dsh-remote-access/status` | listener state, detected interface, bind error |
| Host route `POST /api/dsh-remote-access/config` | live settings, persisted through the settings service |
| Host route `GET /api/dsh-remote-access/key` | links (plain, or with the key when it is on) |
| Host route `POST /api/dsh-remote-access/regenerate` | replaces the key and invalidates every cookie |
| Gateway `http://<mesh-address>:3080/` | optional key gate, then a replay of the harness over loopback |
| Sidebar row **Remote Access** | the page that drives all of the above |

## Security model

- **Off by default.** Nothing binds until a person enables it.
- **The private network is the boundary.** This plugin is built for a mesh whose
  membership you control, so it asks for no key by default: any device that can
  reach the port gets the agent. Keep port 3080 in the network ACL to the devices
  you trust.
- **A key is available, and is opt-in.** For a shared tailnet, turn on **Browser
  access key**: 32 random bytes live in `$DSH_HOME/remote-access/key` (mode
  `0600`), the browser holds only an HMAC cookie, and the harness launch token
  and session cookie never leave the host.
- **One concrete address by default.** The detected `100.64.0.0/10` mesh address
  is preferred over the LAN, so a laptop on café Wi-Fi does not publish an agent
  to the café. `0.0.0.0` is available in the panel, with a warning, when you
  really do control every network the machine joins.
- **Brute force is rate-limited.** When the key is on, eight wrong keys per
  client per 15 minutes.
- **Plain HTTP on the mesh leg.** WireGuard provides transport encryption; the
  gateway adds no TLS. Do not expose the port through Tailscale Funnel, and use
  tailnet ACLs to keep port 3080 to the devices you trust.
- **Revocation is explicit.** Remove the device from the network ACL, or replace
  the key when it is on. There is no per-device key list.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | whether the listener should run |
| `port` | `3080` | TCP port on the mesh address |
| `bindHost` | `auto` | `auto` (detected mesh interface), `all` (`0.0.0.0`), or one IPv4 literal |
| `requireKey` | `false` | optional hardening: whether a browser must present a key first |

The panel writes these through the harness **settings service**, so a value lands
in the profile's `cordis.patch.yml` and survives a restart. A write that cannot be
persisted still applies and is reported as *Applied, but not saved*.

## Tailscale notes

- The plugin does not embed Tailscale. It detects an address in `100.64.0.0/10`
  (the range Tailscale, ZeroTier and NetBird use) and asks `tailscale status
  --json` for the node's MagicDNS name when the CLI is installed. A GUI-only
  install without the CLI symlink still works, with the IP link.
- Restrict the port in your tailnet ACL, for example:

  ```json
  { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:my-mac:3080"] }
  ```

- Funnel publishes to the public internet and is not what this plugin is for.

## Limitations

- The Harness must be running; the gateway lives in its process. Sleeping the
  machine ends remote access.
- The gateway proxies one harness instance (this profile) per process.
- No TLS termination and no certificate management.
- A mesh address is not affected by a LAN change, but a Tailscale re-login can
  change it; the panel rebinds within a minute.

## Develop

```sh
pnpm check                              # typecheck both halves, build, then vitest
scripts/install.sh                      # pack to dist/ and print the install path
scripts/dev-profile.sh boot 19599       # boot in an isolated profile on :19599
scripts/dev-profile.sh remove
```

`test/gateway.spec.ts` is the one that matters: a real HTTP server stands in for
the harness (it checks `Host`, refuses `Origin`, requires its session cookie),
and the gateway is driven end to end over `fetch` and a raw WebSocket handshake.

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | host half: Config, the gateway lifecycle, route registration |
| `src/mesh/gateway.ts` | listener, key gate, HTTP replay, WebSocket tunnel |
| `src/mesh/gate.ts` | cookie signing, unlock page, failure limiter |
| `src/mesh/detect.ts` | interface classifier and Tailscale reader |
| `src/mesh/secret.ts` | the key file |
| `src/routes.ts` | the panel's route family |
| `src/client/` | browser half: sidebar row, page, dictionaries, styles |
| `cordis.patch.yml` | the bundle patch that inserts the Loader row |

## Contributing

Issues and pull requests are welcome — the bug form asks which step of the access
path broke, which is usually enough to reproduce. [CONTRIBUTING.md](.github/CONTRIBUTING.md)
has the commands and the map of what each spec pins. Report vulnerabilities through
[SECURITY.md](.github/SECURITY.md) rather than a public issue. This project follows
the [Contributor Covenant](.github/CODE_OF_CONDUCT.md).

> If remote access from your phone saves you the trip to the desktop, a ⭐ star
> helps other DSH users find it.

## License

MIT — see [LICENSE](LICENSE).
