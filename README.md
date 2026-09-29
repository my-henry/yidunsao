# 一顿扫 (Yidunsao)

批量扫描网址，自动提取代理节点，生成订阅链接。

[![在线体验](https://img.shields.io/badge/在线体验-点击访问-4f378b?style=for-the-badge)](https://yds.chulaile.cloud-ip.cc)

## 功能

- 输入一批网址，自动抓取并解析代理节点
- 支持分享链接（SS / VMess / VLESS / Trojan / Hysteria2 / TUIC / AnyTLS）
- 支持解析 Clash YAML 配置，将节点转为分享链接
- WebSocket 实时反馈扫描进度
- 扫描结果可复制、导出、生成订阅链接

## 推荐扫描平台

本工具本身不产出目标，需要先从资产测绘平台获取目标网址列表。

| 平台 | 地址 | 说明 |
|------|------|------|
| **FOFA** | https://fofa.info | 网络空间资产测绘，语法丰富 |
| **微步在线 X 情报中心** | https://x.threatbook.com | 威胁情报 + 资产测绘 |

**使用流程**：

1. 在平台上用语法搜索目标
2. 导出结果为 JSON，勾选 `host` 或 `URL` 字段
3. 将 JSON 文件上传到本工具进行扫描

## 推荐语法

在 FOFA 或微步在线搜索时，以下语法命中率较高：

```
title="Index of /" && body="vless://"
title="Directory listing for /" && body="vless://"
title="Index of /" && body="sub.txt"
title="管理"&&body="vless"
body="proxies:"&&body="proxy-groups:"&&body="server:"
```

### 语法说明

- **`title="..."`** — 匹配网页标题
- **`body="..."`** — 匹配网页正文内容
- **`&&`** — 逻辑与，两个条件同时满足（前后需加空格）
- **`||`** — 逻辑或
- **`()`** — 分组，提高优先级

**推荐思路**：

1. 使用`<tltle>`搜索确认目标身份，使用`<body>`搜索确认目标包含搜索所需信息。
2. 在进行`<body>`搜索时，搜索常见代理工具节点配置文件字段如：`proxies:` `proxy-groups:` `server:` 

## 快速开始

```bash
git clone https://github.com/你的用户名/yidunsao.git
cd yidunsao
npm install
npm start
```

浏览器打开 `http://localhost:15362`。

## 使用方法

1. 准备一个 `.txt` 或 `.json` 文件，里面放目标网址（一行一个，JSON 需包含 `URL` 或 `HOST` 字段）
2. 在网页上传文件，按需调整扫描模式、并发数、超时等参数
3. 点击「开始扫描」，结果会实时显示
4. 扫描完成后可复制节点、导出 TXT，或获取订阅链接

## 扫描模式

- **订阅提取** — 解析 base64 订阅内容
- **HTML 提取** — 从网页源码提取节点链接
- **遍历扫描** — 递归扫描目录下的常见配置文件

## 环境要求

- Node.js ≥ 20

## 项目结构

```
yidunsao/
├── server.js          # 后端
├── package.json
├── public/            # 前端（index.html / app.js / style.css）
└── README.md
```


## 注意事项

- 仅供学习与安全研究，请勿扫描未授权目标

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。

### 第三方依赖

- [MDUI 2](https://github.com/zdhxiong/mdui) — MIT License
- [Express](https://github.com/expressjs/express) — MIT License
- [ws](https://github.com/websockets/ws) — MIT License
- [axios](https://github.com/axios/axios) — MIT License
- [cheerio](https://github.com/cheeriojs/cheerio) — MIT License
- [js-yaml](https://github.com/nodeca/js-yaml) — MIT License
- [multer](https://github.com/expressjs/multer) — MIT License