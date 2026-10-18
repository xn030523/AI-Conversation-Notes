# 给配置 AI 的执行说明

请为当前员工配置 **远程 MCP + 本地会话钩子**。服务端已经运行在 `https://mcp.daiju.cc.cd`。客户端只需解压此包、选择自己的 `.env` 并安装配置；本机不会启动 MCP 服务。

## 必须确定的输入

1. 员工名字：只能是 `daiju`、`luo`、`ls`、`z` 中的一个。由使用者告诉你；未给出时先询问，不能猜。
2. 使用的客户端：Codex CLI、Claude Code，或两者。仅运行对应客户端的安装命令。
3. 安装目录：压缩包在当前机器解压后的实际绝对路径。下面的 `/home/ubuntu/...` 只属于服务器本机，不能照抄到员工电脑。

| 员工名字 | 包内配置文件 | 预期 MCP 地址 |
| --- | --- | --- |
| `daiju` | `employee-env/daiju.env` | `https://mcp.daiju.cc.cd/mcp?name=daiju` |
| `luo` | `employee-env/luo.env` | `https://mcp.daiju.cc.cd/mcp?name=luo` |
| `ls` | `employee-env/ls.env` | `https://mcp.daiju.cc.cd/mcp?name=ls` |
| `z` | `employee-env/z.env` | `https://mcp.daiju.cc.cd/mcp?name=z` |

## 执行步骤

需要 Node.js 20 或更新版本。以 `luo` 为例；执行时把 `employee_name` 设置为已确定的员工名字：

```bash
tar -xzf conversation-team.tar.gz
cd rustfs-conversation-mcp
employee_name=luo
cp "employee-env/${employee_name}.env" .env
chmod 600 .env
npm ci --omit=dev
```

运行使用者需要的客户端安装命令：

```bash
node dist/cli.js install codex   # 使用 Codex CLI 时执行
node dist/cli.js install claude  # 使用 Claude Code 时执行
```

安装器会从 `.env` 读取 `ARCHIVE_NAME` 和访问凭据，按本机 Node 与安装目录的真实绝对路径写入配置。它会配置：

- Codex MCP：`~/.codex/config.toml`；钩子：`~/.codex/hooks.json`。
- Claude Code MCP：`~/.claude.json`；钩子：`~/.claude/settings.json`。
- 钩子事件：`UserPromptSubmit`、`Stop`、`SessionEnd`。三种事件调用同一项目中的 `dist/cli.js hook codex` 或 `hook claude`。

如果手动修改已有 JSON/TOML 配置，应合并对应的 MCP 和钩子条目，保留文件中其他现有配置。实际配置的完整格式见下方“本机实际配置”。

## 验收

1. `node dist/cli.js status` 应显示服务器 `https://mcp.daiju.cc.cd` 和待上传数量。
2. Codex：`codex mcp get rustfs-conversations` 的 URL 应等于上表中该员工的地址。
3. Claude Code：检查 `~/.claude.json` 中 `mcpServers.rustfs-conversations.url` 等于上表中该员工的地址。
4. 检查对应客户端的三个钩子事件都指向当前机器上的 `dist/cli.js`。重启客户端。Codex 首次使用时，在 `/hooks` 信任钩子命令。
5. 待上传数量大于 0 时，运行 `node dist/cli.js sync` 补传。

向使用者报告所选名字、MCP 地址、已配置的客户端和钩子事件。访问凭据保存在 `.env` 中，报告时无需复制凭据内容。

## 本机实际配置：daiju

以下是当前这台机器 `/home/ubuntu` 上实际生效的配置。项目在 `/home/ubuntu/rustfs-conversation-mcp`，`.env` 中设置 `ARCHIVE_NAME=daiju`，访问凭据保存在该 `.env` 中。其他员工选择包内自己的 `.env`，并把 URL 中的 `name` 和命令的绝对路径改为自己机器上的值。已有配置文件时，把相应条目合并进去。

### Codex MCP

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.rustfs-conversations]
url = "https://mcp.daiju.cc.cd/mcp?name=daiju"
http_headers_helper = "'/home/ubuntu/.local/node22/node_modules/node/bin/node' '/home/ubuntu/rustfs-conversation-mcp/dist/cli.js' headers"
```

`headers` 命令从项目的 `.env` 读取访问凭据，并为 MCP 请求生成 `Authorization` 请求头。

### Codex 钩子

编辑 `~/.codex/hooks.json`：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'/home/ubuntu/.local/node22/node_modules/node/bin/node' '/home/ubuntu/rustfs-conversation-mcp/dist/cli.js' hook codex",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'/home/ubuntu/.local/node22/node_modules/node/bin/node' '/home/ubuntu/rustfs-conversation-mcp/dist/cli.js' hook codex",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'/home/ubuntu/.local/node22/node_modules/node/bin/node' '/home/ubuntu/rustfs-conversation-mcp/dist/cli.js' hook codex",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### Claude Code MCP

在 `~/.claude.json` 的 `mcpServers` 中添加：

```json
{
  "mcpServers": {
    "rustfs-conversations": {
      "type": "http",
      "url": "https://mcp.daiju.cc.cd/mcp?name=daiju",
      "headersHelper": "'/home/ubuntu/.local/node22/node_modules/node/bin/node' '/home/ubuntu/rustfs-conversation-mcp/dist/cli.js' headers"
    }
  }
}
```

### Claude Code 钩子

编辑 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'/home/ubuntu/.local/node22/node_modules/node/bin/node' '/home/ubuntu/rustfs-conversation-mcp/dist/cli.js' hook claude",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'/home/ubuntu/.local/node22/node_modules/node/bin/node' '/home/ubuntu/rustfs-conversation-mcp/dist/cli.js' hook claude",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'/home/ubuntu/.local/node22/node_modules/node/bin/node' '/home/ubuntu/rustfs-conversation-mcp/dist/cli.js' hook claude",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

修改配置后重启客户端。Codex 首次使用钩子时，在 `/hooks` 中信任这些命令。
