# Cloudflare setup

The server listens on the Mac only. It reaches the internet through a Cloudflare Tunnel, behind Cloudflare Access: only the emails on the application's policy can sign in. This page is the one-time setup, the ways to let agents in, and how to check that it all works.

## The application and the tunnel (once)

1. **Access application.** Zero Trust → Access → Applications → Add → Self-hosted. Domain `meetings.example.com`, policy *Allow* with *Emails* set to the addresses of the people who may sign in, the same ones as `ACCESS_USERS` in `.env`. Copy the **Application Audience (AUD) tag** into `ACCESS_AUD` in `.env`.
2. **Tunnel.** `cloudflared tunnel create meetings`, then `cloudflared tunnel route dns meetings meetings.example.com`.
3. **Services.** `ops/install.sh server && ops/install.sh tunnel`. The tunnel refuses to install until `ACCESS_TEAM`, `ACCESS_AUD` and `ACCESS_USERS` are set.

The tunnel runs by its id with its own credentials file (`~/.cloudflared/<id>.json`). `ops/install.sh tunnel` looks the id up once by name and keeps it in `.env` as `TUNNEL_ID`. That lookup is the only step that needs `~/.cloudflared/cert.pem`, which can manage every tunnel on the account. It can move off this Mac once no tunnel here runs by name.

## Letting agents in

There are three ways, and all of them can be on at once.

**The connector hostname.** For Claude's apps, and for agents that sign in with OAuth on someone's own machine: Claude Code, Codex, Hermes. The server signs them in itself on `meetings-mcp.example.com` (below), after a person approves each one on the site. Nothing changes in Cloudflare per agent.

**Sign in as yourself.** For hosted assistants whose callback is allowed on the application, such as ChatGPT. Turn on *Managed OAuth* in the application's Advanced settings and allow only the callback URLs of the clients in use, plus localhost. The assistant opens Cloudflare's sign-in page, the person signs in, and the connection's changes are credited to "Ada's agent" or "Grace's agent".

**Service token.** For a script or bot that can't sign in with OAuth but can send headers. Zero Trust → Access → Service credentials → create one token per agent, add a *Service Auth* policy for it to the meetings application, and list its client id in `ACCESS_SERVICE_TOKENS` as `<client id>=<name>:write`, or without `:write` to keep it read-only.

Client-side configuration for each agent is in [`docs/agents.md`](agents.md), and the README's [Connect an agent](../README.md#connect-an-agent) has a block to paste into one.

## Hosted assistants

A hosted assistant connects from its provider's servers, in three steps: it reads `/.well-known/oauth-protected-resource/mcp` to find the sign-in server, sends the person there to sign in, and then calls `/mcp` with the token it got. On `meetings.example.com` that sign-in server is Cloudflare Access. On the connector hostname it is this server.

- **Callback URLs.** Claude's are `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`. Both are allowed on the application.
- **Claude's connectors use a second hostname.** Claude's hosted connectors can't finish Access's managed OAuth ([anthropics/claude-ai-mcp#980](https://github.com/anthropics/claude-ai-mcp/issues/980)): the sign-in is allowed, then the connection never arrives. So `meetings-mcp.example.com` is routed to the same tunnel (`cloudflared tunnel route dns <tunnel id> meetings-mcp.example.com`) with **no** Access application on it, and `CONNECTOR_URL` in `.env` names it. The server answers only its own OAuth endpoints and the two MCP doors there, and sends people to `meetings.example.com/connect/authorize` (behind Access) to approve. Nothing else of the site is served on it. Command-line agents sign in there too, with a callback on their own machine. Because the approval page is on another hostname than the issuer, every answer names the issuer (RFC 9207) and the metadata says so, which Codex requires.
- **Protocol versions.** The endpoint speaks MCP 2026-07-28 next to the older revisions. Claude's connectors (the desktop app and the CLI) currently send the older version in the `MCP-Protocol-Version` header with a 2026-07-28 request ([anthropics/claude-code#93290](https://github.com/anthropics/claude-code/issues/93290)). The specification says to refuse that; this server lets it through, because the body names the version, and refusing would refuse every call those connectors make.
- **Origins.** Some connectors send an `Origin` header with their calls. The server answers the ones listed in `MCP_ORIGINS`, which defaults to `https://claude.ai,https://claude.com`. If another assistant is refused with "cross-origin request refused", add its site to the list. Set the variable to nothing to allow this site only.
- **Which email.** The email that matters is the one typed on the Cloudflare Access page, not the one the assistant's account uses. It has to be on the application's policy and in `ACCESS_USERS`.
- **One application or two.** One Access application covers the whole site, `/mcp` included. If `/mcp` ever gets its own application, list both audience tags in `ACCESS_AUD`, separated by a comma.

## A rate limit on the connector hostname

The connector hostname has no Access application in front of it, so anyone can send it requests. The server answers its sign-in steps and refuses everything else that carries no valid token, and Cloudflare can stop a flood before it reaches the Mac. On the domain's **Security rules** page, create one **rate limiting rule**:

| Setting | Value |
| :-- | :-- |
| When incoming requests match | Hostname equals `meetings-mcp.example.com` |
| With the same characteristics | IP |
| When rate exceeds | 100 requests in 10 seconds |
| Then take action | Block, for 10 seconds |

The Free plan allows one such rule per domain, and 10 seconds is its only period and its only duration. A paid plan can block for longer. An agent sends a few requests per question, far below the limit. The site's own hostname needs no rule: Access answers there before a request reaches the tunnel.

## Check it

From anywhere, without signing in:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://meetings.example.com/                                            # 401: Access is in front
curl -s -o /dev/null -w "%{http_code}\n" https://meetings.example.com/.well-known/oauth-protected-resource/mcp    # 200: Managed OAuth is on
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -d '{}' https://meetings.example.com/mcp    # 401: sign-in required
curl -s https://meetings-mcp.example.com/.well-known/oauth-authorization-server | grep -c iss_parameter_supported    # 1: the connector's sign-in, ready for Codex
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -d '{}' https://meetings-mcp.example.com/mcp    # 401: sign-in required there too
```

The rate limit, also from anywhere. About a hundred requests get the server's 401 and the rest Cloudflare's 429. Ten seconds later the 401 is back:

```bash
seq 160 | xargs -P 16 -I{} curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -d '{}' https://meetings-mcp.example.com/mcp | sort | uniq -c
```

On the Mac itself:

```bash
launchctl list | grep ontherecord                                     # server, tunnel, embed, rerank (and ask and screens, once installed)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8797/api/library       # 200: the server is up
```

The origin rule, also on the Mac. The first two answer 200 and the last one 403:

```bash
BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -d "$BODY" http://127.0.0.1:8797/mcp/readonly
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -H "Origin: https://claude.ai" -d "$BODY" http://127.0.0.1:8797/mcp/readonly
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -H "Origin: https://example.com" -d "$BODY" http://127.0.0.1:8797/mcp/readonly
```

## A note on video

Cloudflare's CDN terms reserve the right to limit sites that mostly serve video without a paid video product. Two people watching their own meetings is a small footprint. If it ever becomes an issue, Stream or R2 are the sanctioned routes.
