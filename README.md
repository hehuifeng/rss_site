# Paper Tracker (Self-contained)

这个版本**不依赖 CDN**，需要在站点根目录放置两份文件：
- `sql-wasm.js`
- `sql-wasm.wasm`

## 获取文件（任选其一）

### 方式 A：使用 CDN 下载到本地
```bash
# 在项目根目录（与 index.html 同级）执行
curl -L -o sql-wasm.js   https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js
curl -L -o sql-wasm.wasm https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.wasm
```

### 方式 B：用 npm 拉取后拷贝
```bash
npm init -y
npm i sql.js@1.10.2
# 将 node_modules/sql.js/dist/sql-wasm.js 和 sql-wasm.wasm 复制到站点根目录
cp node_modules/sql.js/dist/sql-wasm.* .
```

## 本地预览
```bash
python3 -m http.server 3000
# 打开 http://localhost:3000
```

## GitHub Pages 部署
1. 把整个目录推到仓库根目录（包含 `sql-wasm.js` / `sql-wasm.wasm` / `data/rss_state.db`）
2. Settings -> Pages -> Branch: main (/root)
3. 等待几秒构建完成后访问托管地址即可

## 数据库路径
前端从 `data/rss_state.db` 读取数据库，如需替换，只需把新的 db 覆盖到该路径，无需改代码。
