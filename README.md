# RustFS Conversation MCP

TypeScript 编写的多用户会话归档服务。Codex CLI 和 Claude Code 的本地钩子读取会话记录，通过 HTTPS 上传到服务端；HTTP MCP 提供按用户隔离的查询工具。仅安装远程 MCP 无法读取客户端本机的转录文件，因此要同时安装钩子。

## 当前部署

- MCP：`https://mcp.daiju.cc.cd/mcp`
- S3 API：`https://s3.daiju.cc.cd`，桶 `conversations`
- RustFS 控制台：`https://s3.daiju.cc.cd/rustfs/console/`
- 存储路径：`conversations/users/<用户ID>/<会话ID>.json`
- 本机后端：RustFS `127.0.0.1:9000`、控制台 `127.0.0.1:9001`、MCP `127.0.0.1:5080`

同一会话 ID 始终更新同一个 JSON。`transcript` 是最新的完整转录内容，`events` 保存每次钩子的输入、时间与错误信息。上传失败的事件会留在客户端的私有队列，下一次钩子或手动 `sync` 会重试。

当前公司配置使用一份共用访问凭据，按客户端传来的 `name` 分目录。服务端允许的名字为 `daiju,luo,ls,z`；例如 `name=luo` 对应 `users/luo/<会话ID>.json`。MCP 地址和钩子上传地址都附带相同的名字。现有 `daiju` 记录保留原路径。

## 四位员工的配置

服务器上的分发目录是 `/home/ubuntu/employee-configs/`，其中只有 `conversation-team.tar.gz` 一个压缩包。包内含：

- 客户端钩子、MCP 配置程序、依赖清单。
- `EMPLOYEE-SETUP.md`：员工安装说明。
- `employee-env/daiju.env`、`employee-env/luo.env`、`employee-env/ls.env`、`employee-env/z.env`。

每份 `.env` 文件含相同的 MCP 地址与公司访问凭据，但 `ARCHIVE_NAME` 各不相同。不含 RustFS 密钥。服务端在 `.server.env` 的 `ARCHIVE_NAMES` 中控制允许的名字；以后增加员工，先加名字并重启服务，再把新名字的配置放入压缩包。

## 客户端安装

客户端需要 Node.js 20 或更新版本、共用安装包，以及 Codex CLI 或 Claude Code。每台客户端机器执行：

```bash
tar -xzf conversation-team.tar.gz
cd rustfs-conversation-mcp
cp employee-env/luo.env .env  # 示例：luo；其他员工选择自己的文件
chmod 600 .env
npm ci --omit=dev
node dist/cli.js install codex
node dist/cli.js install claude
```

只用一个客户端时只执行对应的 `install`。安装器在 Codex `~/.codex/config.toml` 与 Claude Code `~/.claude.json` 配置远程 HTTP MCP，并安装 `UserPromptSubmit`、`Stop`、`SessionEnd` 本地钩子。MCP 请求头辅助命令读取 `.env` 的公司访问凭据；URL 的 `name` 参数和钩子上传均读取同一文件的 `ARCHIVE_NAME`。重启客户端后生效；首次使用 Codex 钩子时在 `/hooks` 信任命令。员工本机不会运行 MCP 服务。

```bash
node dist/cli.js status  # 查看待上传数量
node dist/cli.js sync    # 重试私有队列
```

MCP 工具：`archive_status` 显示当前用户与会话数，`archive_list` 列出会话，`archive_read` 按会话 ID 读取完整 JSON。

## 服务端部署

服务器凭据放在权限为 `600` 的 `.server.env`，参照 `.server.env.example`。客户端 `.env` 参照 `.env.example`。服务端首次运行 `node dist/cli.js init` 创建桶，然后使用 `deploy/rustfs-conversation-mcp.service` 启动服务。

Nginx 配置见 `deploy/nginx-domains.conf`；证书由 Certbot 为两个域名签发，使用 `deploy/update-cloudflare-ips.sh` 下载 Cloudflare 官方 IP 列表并生成 Nginx 访问控制文件。Cloudflare DNS 使用代理模式，SSL/TLS 模式应为 **Full (strict)**。HTTP 仅用于证书验证和跳转 HTTPS。Nginx 只允许 Cloudflare 地址访问域名站点，未匹配域名的请求被拒绝；RustFS 和 MCP 后端只绑定本机地址。证书由 `certbot.timer` 自动续期。

旧版桶根目录的会话文件可使用 `node scripts/migrate-v2.mjs <用户ID>` 预览、加 `--apply` 迁移。脚本验证新对象后才删除旧对象。当前服务器上的两条旧记录已迁移到 `users/daiju/`。

本方案支持可运行本地钩子的 Codex CLI 和 Claude Code。Claude 网页版、Claude Desktop 及无法运行本地钩子的会话不在采集范围内。Cloudflare 代理对单次 HTTP 上传有套餐相关的大小限制；较大的转录文件可能留在客户端队列并报上传错误。

参考：[Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Codex MCP](https://developers.openai.com/codex/mcp)、[Claude Code Hooks](https://code.claude.com/docs/en/hooks)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)。
