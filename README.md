# 一顿扫 (Yidunsao)

批量扫描网址，自动提取代理节点，生成订阅链接。

## 功能

- 输入一批网址，自动抓取并解析代理节点
- 支持分享链接（SS / VMess / VLESS / Trojan / Hysteria2 / TUIC / AnyTLS）
- 支持解析 Clash YAML 配置，将节点转为分享链接
- WebSocket 实时反馈扫描进度
- 扫描结果可复制、导出、生成订阅链接

## 快速开始

```bash
git clone https://github.com/你的用户名/yidunsao.git
cd yidunsao
npm install
npm start
```

浏览器打开 `http://localhost:15362`。

## 使用方法

1. 准备一个 `.txt` 或 `.json` 文件，里面放目标网址（一行一个，JSON 需包含 `URL` 或 `host` 字段）
2. 在网页上传文件，按需调整扫描模式、并发数、超时等参数
3. 点击「开始扫描」，结果会实时显示
4. 扫描完成后可复制节点、导出 TXT，或获取订阅链接

## 扫描模式

- **订阅提取** — 解析 base64 订阅内容
- **HTML 提取** — 从网页源码提取节点链接
- **遍历扫描** — 递归扫描目录下的常见配置文件

## 环境要求

- Node.js ≥ 18

## 项目结构

```
yidunsao/
├── server.js          # 后端
├── package.json
├── public/            # 前端（index.html / app.js / style.css）
└── README.md
```

运行时自动生成 `sub/`（订阅文件）和 `uploads/`（临时文件），已加入 `.gitignore`。

## 注意事项

- 内置 SSRF 防护、速率限制、订阅文件 24 小时自动清理
- 仅供学习与安全研究，请勿扫描未授权目标

## 许可证

MIT