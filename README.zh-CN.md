# Blender 产品建模与摄影 Agent

这是一个可独立下载的本地项目：管理产品资料、可编辑 Blender 模型、摄影场景、版本和渲染图。核心工具通过 **stdio MCP** 提供给 Claude Code、Codex 或其他本地 MCP 客户端。网页里的 Codex 聊天只是可选入口。

## 安装

需要 Node.js 22 及以上、Blender，以及足够的本地磁盘空间。开发环境使用 Blender 5.2.1；其他版本需自行核对兼容性。只有使用网页内置聊天时才需要 Codex 登录。

```bash
git clone https://github.com/SanJoeng/blender-product-studio-agent.git
cd blender-product-studio-agent
npm ci
npm run build
npm start
```

打开 `http://127.0.0.1:4318`。Mac 也可以运行 `Start.command`。找不到 Blender 时，参考 [.env.example](.env.example) 设置 `BLENDER_PATH`。项目资料默认放在 `.studio/`，不会被 Git 提交；请自行备份。

## 接入 Claude Code

保持 `npm start` 运行，在另一终端执行，把路径换成下载目录的**绝对路径**：

```bash
claude mcp add --transport stdio product-studio -- node /ABSOLUTE/PATH/blender-product-studio-agent/dist/mcp-external.js
```

在 Claude Code 里让它先调用 `list_projects`，再调用 `select_project` 或 `create_project`；建模前用 `read_skill` 读取 `SKILL.md`。之后可以把实拍、尺寸和贴图交给它，要求创建 `.blend`、小预览和不同机位。Claude Code 的[官方 MCP 配置说明](https://code.claude.com/docs/en/mcp)可用于核对连接方式。这条路径不使用 Codex 登录。

其他 AI harness 只要支持**本地 stdio MCP**，配置 `node` 为命令、`dist/mcp-external.js` 的绝对路径为参数即可。Studio 服务和 MCP 客户端需在同一台机器。若改了端口或数据目录，给两边相同的 `STUDIO_URL` / `STUDIO_DATA_DIR`。

工作顺序：项目选择 → 阅读技能 → `import_local_input` 导入用户提供的实拍或贴图（已有 `.blend` 用 `import_blend_path`）→ `view_image` 查看参考 → `edit_scene` → `get_job` 等实际完成 → `render_scene` → `get_job` → `view_image` 检查。每次修改另存版本；只有明确接受时才把版本标为“已确认”。模型主资产可发布给链接场景复用，旧成片不会自动改动。

更多功能、安全边界和开发命令见 [English README](README.md) 与 [安全说明](SECURITY.md)。许可证为 [GPL-3.0](LICENSE)。本仓库只包含通用示例，不包含任何客户产品资料。
