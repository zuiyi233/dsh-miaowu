# 喵呜小说工坊（Agent 预设）

插件自带的 Agent 预设：**标准模式全能力 + 小说创作 persona**。

## 这是什么

- DSH 预设 = 一个目录（含 `preset.yml` + `agent.cordis.yml`），解决"以什么方式跑 Agent"（persona、工具行）；插件挂载本身是 profile 级 `cordis.patch.yml` 的事。
- 本预设的 `agent.cordis.yml` 是内置 `standard` 组合的完整复制，仅 `persona` 行换成中文小说创作向；工具面与标准模式一致。
- 与标准模式的差异 = persona 不同（建项约定：工程建在工作区根或一级书名目录，含 `正文/` 或 `追踪/`；新建走 story-setup，写作走 story 系列 skill，落盘后指向 `/oh-story` 工作台）+ 同一工具面。

## 安装

```bash
pnpm --filter @dsh-miaowu/dsh preset:install
```

复制到 `<homedir>/.dsh/.agent-presets/dsh-miaowu/`（幂等，已存在且内容相同则跳过）。只写这一个目录，不碰 `~/.dsh` 下其他文件。

## 卸载

```bash
pnpm --filter @dsh-miaowu/dsh preset:remove
```

## 装完在哪看到

重启 DSH 后，在"设置 → Agent 预设"可见"喵呜小说工坊"。

## 同步风险

`standard` 未来升级后本副本不会自动跟随；升级宿主后请 diff 内置 `standard/agent.cordis.yml` 并手动同步（除 `persona` 行外保持一致）。
