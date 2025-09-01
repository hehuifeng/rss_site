# RSS Paper Tracker

一个纯前端的学术资讯聚合站。定时抓取 Nature 旗下多个期刊的 RSS，自动使用 [DashScope](https://dashscope.aliyuncs.com/compatible-mode/v1) 的 `qwen-flash` 模型翻译标题，并根据关键词为文章打标签。

> 标签通过在标题和摘要中匹配关键词实现，因此结果不一定完全准确。

## 功能
- 聚合并展示以下 RSS 源：
  - https://www.nature.com/ncomms.rss
  - https://www.nature.com/nbt.rss
  - https://www.nature.com/nmeth.rss
  - https://www.nature.com/nature.rss
  - https://www.nature.com/natcancer.rss
  - https://www.nature.com/natmachintell.rss
  - https://www.nature.com/natcomputsci.rss
- 在“说明”页介绍项目目的、数据来源及关键词列表。
- 使用 [sql.js](https://github.com/sql-js/sql.js) 存储抓取记录，无需后端即可运行。
- 简洁现代的界面，文章卡片在鼠标悬停时高亮边框。

## 使用方法
1. 将 `sql-wasm.js` 和 `sql-wasm.wasm` 放到站点根目录：
   ```bash
   curl -L -o sql-wasm.js   https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js
   curl -L -o sql-wasm.wasm https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.wasm
   ```
   或者通过 npm：
   ```bash
   npm init -y
   npm i sql.js@1.10.2
   cp node_modules/sql.js/dist/sql-wasm.* .
   ```
2. 本地预览：
   ```bash
   python3 -m http.server 3000
   ```
   打开浏览器访问 `http://localhost:3000`。

## 部署
1. 将整个目录（包含 `sql-wasm.js`、`sql-wasm.wasm`、`data/rss_state.db`）推送到仓库。
2. 在 GitHub Pages 中选择 `main` 分支的根目录进行部署。
3. 等待构建完成后即可访问托管地址。

## 数据库
站点读取 `data/rss_state.db` 来保存抓取状态，如需替换，直接用新的文件覆盖即可，无需修改代码。
