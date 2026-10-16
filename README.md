# RSS Paper Tracker

线上地址：

- <https://paper.huifeng.he.cn/>（自建，源站在国内，附带统计 API）
- <https://hehuifeng.github.io/rss_site/>（GitHub Pages 镜像）

一个纯前端的学术资讯聚合站。每天 06:00 自动抓取 Nature 旗下多个期刊的 RSS,用 [DashScope](https://dashscope.aliyuncs.com/compatible-mode/v1) 的 `qwen-flash` 模型翻译标题/摘要,按关键词打标签,写入 SQLite 数据库。

> 标签通过在标题和摘要中匹配关键词实现，因此结果不一定完全准确。

## 架构(2026-10 重构)

```
每日 cron(见 Nature_task_generate/run_daily.sh)
  抓取 RSS → 翻译 → 写库 → VACUUM → gzip -9(28MB → ~8.5MB)
    ├─ 写入 data/rss_state.db[.gz]    ← paper.huifeng.he.cn(Apache)直接对外服务
    └─ 上传阿里云 OSS                  ← GitHub Pages 版前端的数据主源
  git 只提交代码变更(data/ 不进版本库)

前端(index.html + app.js + sw.js,两处部署共用一套代码)
  数据库多源回退: ①OSS ②同源 ./data/rss_state.db.gz ③paper.huifeng.he.cn 兜底
  流式下载 + DecompressionStream 边下边解压;魔数嗅探免疫服务器透明解压
  Service Worker:壳 precache + 数据库 SWR 缓存 → 回访秒开、可离线
  筛选状态(q/日期/期刊/类型/tag/页码/排序/双语/tab)同步到 URL query,可分享
```

功能:关键词(空格/逗号分隔,AND)、日期区间与快捷范围、期刊/类型/标签筛选(带计数)、
排序、双语显示、摘要折叠/展开、导出 CSV/BibTeX、复制 DOI、深色模式、键盘快捷键
(`/` 聚焦搜索,`←`/`→` 翻页)、PWA(可安装、可离线)。

## RSS 源

nature / natcancer / nmeth / nprot / nbt / ncomms / natmachintell / natcomputsci / nrm / nrg / nrc
(完整列表见站点「说明」页;欢迎提 issue 增加新期刊)

## 本地开发

```bash
# 1) 需要一份未压缩数据库(老浏览器回退路径;直接解压现有 gz 即可)
gzip -dk data/rss_state.db.gz     # 或从 nature_task_generate 拷贝 rss_state.db

# 2) 启动静态服务(localhost 是安全上下文,SW 可注册)
python3 -m http.server 3000 --directory .
# 打开 http://localhost:3000
```

sql.js(`sql-wasm.js`/`sql-wasm.wasm`)已 vendor 在仓库根目录,无需 npm 安装。

## 阿里云 OSS 配置(一次性)

1. 创建 bucket(公共读,如 `paper-tracker-data`,地域任选,默认外链域名无需备案);
2. RAM 创建子用户,只授予该 bucket 的 `oss:PutObject/GetObject`,生成 AccessKey;
3. 填入 `nature_task_generate/config_oss.json`(参考 `config_oss.json.example`,已 gitignore);
4. OSS 控制台配置 CORS:来源 `https://hehuifeng.github.io`、`https://paper.huifeng.he.cn`、
   `http://localhost:*`;方法 GET/HEAD;AllowedHeaders `*`;ExposeHeaders `ETag, Last-Modified, Content-Length`;
5. 在 `app.js` 顶部把 `OSS_DB_URL` 填为外链地址(留空则跳过该候选)。

未配置 OSS 时 cron 自动跳过上传(仅告警),自建部署不受影响。

## 数据库

- 表 `articles`:uid, feed_url, journal, title_en/cn, type, pub_date, doi, article_url,
  abstract_en/cn, raw_jsonld, fetched_at, last_updated_at, topic_tag;
- 前端用 [sql.js](https://github.com/sql-js/sql.js) 在浏览器内存中查询;
- 更新机制开源于 [hehuifeng/Nature_task_generate](https://github.com/hehuifeng/Nature_task_generate)。

## 部署与缓存说明

| 部署 | 壳 | 数据库 | 备注 |
|---|---|---|---|
| paper.huifeng.he.cn | Apache 直挂本目录 | 同源 `data/`(`.htaccess` 控制 CORS/缓存) | Cloudflare 在前,`.gz` 不被边缘缓存,故作兜底 |
| hehuifeng.github.io | `master` 分支(GitHub Pages) | OSS 主源 → 同源 404 → ③兜底 | data/ 不进 git,仓库保持 KB 级 |

- `sw.js` 修改后必须 bump 文件内 `VERSION`,否则客户端不更新;
- 排查加载问题:浏览器控制台过滤 `[db]`,会打印每个数据源的成败;DevTools →
  Application → Cache Storage 可见 `pt-shell-*` / `pt-db-*` 两组缓存。

## 成本

OSS 存储忽略不计;下行流量 0.5 元/GB 量级,按当前访问量约 **3-15 元/月**。
上传走「md5 未变化不重传」策略,几乎不耗家宽上行。
