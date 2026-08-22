<div align="center">

# Tau Mirror Web

[English](./README.md) · **简体中文**

[Pi](https://github.com/earendil-works/pi) 编程助手的浏览器界面。

GitHub 仓库首页默认打开 [英文 README](./README.md)。  
你现在看的是中文版。

网页本身会先看系统 / 浏览器语言：`zh*` 用中文，其他语言用英文。之后可在 **设置** 里改。

</div>

## 这是什么

Tau 跑在 **已经启动的 Pi 进程里**，不用再开一套服务器。扩展会起一个很小的 HTTP + WebSocket 服务，把同一段会话镜像到浏览器：消息、工具、思考、当前模型，都和终端同步。

这个仓库相对上游，多做了这些事：

- 模型 / 中转站报错会直接出现在对话里
- 可以在网页里添加 OpenAI 兼容 **中转站**
- 保留 `/CN/...` 这种模型 ID（HFY 等国内中转）
- 界面按系统语言优先展示

## 安装

从这个仓库安装：

```bash
pi install git:github.com/TaoXiaoBai/tau-mirror-web
```

或者克隆后用本地文件：

```bash
git clone https://github.com/TaoXiaoBai/tau-mirror-web.git
cd tau-mirror-web
```

Windows PowerShell：

```powershell
$env:TAU_STATIC_DIR = (Resolve-Path .\public)
pi
```

也可以把扩展路径写进 `~/.pi/agent/settings.json`。

## 使用

1. 和平时一样启动 `pi`
2. 打开状态栏里的地址（默认 `http://localhost:3001`）
3. 在终端或浏览器里说话，都是同一段会话

终端里输入 `/qr` 可以出二维码，手机扫了就能用。

## 功能

### 对话
- 实时流式输出、Markdown、公式、复制、粘贴 / 拖拽图片
- 工具卡片和思考过程
- 模型失败会在对话里显示，不再是空白气泡
- Pi 还在答的时候可以先排队下一条

### 中转站
- 打开左上角 **模型列表**
- 每个中转分组旁边有 **编辑**，底部是 **添加中转站**
- 先测连接，再保存并同步 `/v1/models`
- 模型 ID 开头的 `/` 会原样保留（`/CN/gpt-4o` 还是 `/CN/gpt-4o`）

### 会话
- 左侧历史、搜索、恢复旧会话
- 上下文占用条，可选自动整理

### 语言
- 第一次打开：读 `navigator.languages`
- 中文环境用中文界面
- 其他环境用英文
- 之后可在 **设置 → 语言** 里改

## 配置

| 变量 | 默认 | 含义 |
|---|---|---|
| `TAU_MIRROR_PORT` | `3001` | 端口 |
| `TAU_HOST` | `0.0.0.0` | 监听地址（只本机就用 `127.0.0.1`） |
| `TAU_STATIC_DIR` | 自带的 `public/` | 覆盖前端文件 |
| `TAU_DISABLED` | `0` | `1` 时不自动启动 |
| `TAU_USER` / `TAU_PASS` | 空 | HTTP Basic 登录 |

也可以写在 `~/.pi/agent/settings.json`：

```json
{
  "tau": {
    "port": 3001,
    "user": "pi",
    "pass": "change-me"
  }
}
```

命令：`/tau-stop`、`/tau-start`、`/qr`、`/tau`。

中转站保存在 `~/.pi/agent/models.json`。网页里保存会写这个文件，并注册到 Pi。升级扩展后请重启 Pi，后端新接口才会生效。

## 原理

```
Pi 终端  <──>  Pi 进程（tau 扩展：HTTP + WS :3001）  <──>  浏览器
```

扩展订阅 Pi 事件，转发给所有打开的标签页。浏览器里的操作再走同一套扩展 API 回来。

## 许可

MIT。基于 [deflating/tau](https://github.com/deflating/tau)。
