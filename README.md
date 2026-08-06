# 智能多格式批量下单系统 V4

基于 Next.js App Router + TypeScript 的万能导入系统。应用按鲸天系统风格重做了后台壳、导航、表格和操作流，支持 Excel / Word / PDF 上传，使用规则引擎解析为出库单 SKU 明细，并按外部编码聚合展示为出库单。

## V4 异步导入链路

V4 保留 V2 的解析规则 DSL、字段映射和 Excel / Word / PDF 解析器，主导入链路改为：

`上传 -> import_tasks + event_outbox 事务 -> Dispatcher -> 分批 Worker -> 批量 SKU 校验 -> createMany 幂等写入 -> 进度/错误/Trace/监控`

上传接口只保存文件、创建任务并返回 `task_id`，不会在请求内等待 10,000 行导入。默认批次大小为 500 行；数据库 Outbox 提供可恢复投递，Worker 对同一 `task_id + batch_index + row_number` 幂等。

页面入口：

- `/`：选择文件和 V2 解析规则，创建异步导入任务；
- `/imports/:taskId`：任务进度、批次状态、行级错误和 Trace 入口；
- `/import-monitor`：吞吐、队列积压、阶段 P50/P95/P99、错误分布。

## 本地运行

```bash
npm install
npx prisma generate
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。

首次使用 V4 数据链路时执行：

```bash
npx prisma db push
npm run seed:data
```

`seed:data` 会清理并批量写入 20,000 条 `sku_master`，生成 `test-data/10000-orders.xlsx`，并随机插入非法 SKU。可用 `SEED_SKU_COUNT` 和 `SEED_ORDER_COUNT` 调整规模。

只重新生成 Excel 而不连接数据库：PowerShell 使用 `$env:GENERATE_FILE_ONLY="1"; npm run seed:data`。

生产环境连接 Upstash QStash 后，Dispatcher 只发送 `outboxId`，QStash 调用带签名校验的 `/api/import-worker/job` Vercel Route Handler 执行批次。浏览器通过 `/api/import-uploads` 获取受限上传凭证并把大文件直接写入私有 Vercel Blob，任务 API 只接收 Blob URL 和规则元数据，绕过 Vercel 函数请求体限制。未配置 QStash/Blob 时，本地开发分别使用数据库任务队列和本地文件系统。数据库、QStash、Blob 和模型密钥均通过环境变量配置，代码不包含真实密钥。

## 压测与验收

```bash
npm run load:test
```

可通过 `LOAD_TEST_URL`、`LOAD_TEST_FILE`、`LOAD_TEST_RULE` 指定目标地址、压测文件和已确认规则。脚本记录上传耗时、任务总耗时、成功/失败行数、500/504 和是否达到 60 秒目标。详细容量假设见 [V4-重构假设说明.md](docs/V4-重构假设说明.md)，接口定义见 [V4-接口文档.md](docs/V4-接口文档.md)。

Outbox、错误和性能日志应按生产保留周期归档；压测环境可重复执行 `seed:data` 重建 SKU 和文件。

## 环境变量

复制 `.env.example` 到 `.env` 或在 Vercel Project Settings 中配置同名变量。

```bash
DATABASE_URL=""
POSTGRES_PRISMA_URL=""
POSTGRES_URL_NON_POOLING=""

OPENAI_API_KEY=""
OPENAI_BASE_URL=""
OPENAI_MODEL=""

QSTASH_URL=""
QSTASH_TOKEN=""
QSTASH_CURRENT_SIGNING_KEY=""
QSTASH_NEXT_SIGNING_KEY=""
BLOB_READ_WRITE_TOKEN=""
```

大模型配置只在服务端 Route Handler 中读取，没有 `NEXT_PUBLIC_` 前缀，不会进入浏览器包。考试可配置为：

```bash
OPENAI_BASE_URL="https://988665.xyz/v1"
OPENAI_MODEL="gpt-5.5"
OPENAI_API_KEY="<your server-side key>"
```

## Vercel 部署

线上地址：[https://my-vercel-app-0807.vercel.app](https://my-vercel-app-0807.vercel.app)，源码仓库：[GitHub](https://github.com/mdzmjfreedom/my-vercel-app-0807)。Vercel 项目关联 GitHub `main` 分支，推送后由 Vercel 构建部署。

在 Vercel Project Settings 的 Environment Variables 中配置本 README 上一节列出的变量，并分别连接 Neon PostgreSQL、Vercel Blob 和 Upstash QStash。环境变量值不提交到 Git；`.env` 只用于本地运行。部署前执行 `npx prisma db push`，部署后访问 `/api/import-monitor/summary` 可确认数据库、队列和监控接口正常。

## 演示访问

本考试项目没有登录拦截，不需要演示账号。考官可直接访问：

- [导入页](https://my-vercel-app-0807.vercel.app/)：上传文件、选择或生成解析规则并创建任务；
- [任务页](https://my-vercel-app-0807.vercel.app/imports/task_43c68c8ccbd4416fb1a7)：查看 10,000 行实测任务的进度、批次和错误；
- [监控页](https://my-vercel-app-0807.vercel.app/import-monitor)：查看吞吐、队列积压、阶段分位数和错误分布；
- [Trace 页](https://my-vercel-app-0807.vercel.app/traces/trace_ced2e5110887410cb094)：查看该压测任务的事件时间线。

## 故障模拟

故障模拟应在本地或独立测试部署中执行，不要临时修改正式演示环境的密钥。

1. 行级业务失败：执行 `npm run seed:data` 后使用生成的 `test-data/10000-orders.xlsx` 压测。文件预置 11 行不存在的 SKU；任务应为 `PARTIAL_SUCCESS`，成功 9,989 行、失败 11 行，错误列表显示 `E001`，其余合法行继续入库。
2. 文件准备失败：复制一份无效内容并改为 `.xlsx` 后上传。任务应进入失败/重试链路，Trace 中出现文件准备失败事件，不能生成部分批次数据。
3. 消息投递失败：在独立测试环境配置无效的 `QSTASH_TOKEN` 后创建任务。Outbox 应保留为可重试状态并增加 `retry_count`，监控页队列积压上升；恢复正确密钥后由补投递或恢复扫描继续处理。
4. 重复消费：在本地数据库回退模式下，对已完成 Outbox 再次调用 Worker。批次状态和唯一 `dedupeKey` 应使运单数、成功数和完成批次数保持不变。

压测证据、架构、接口和提交说明见 [docs/V4-交付物详细列表.md](docs/V4-交付物详细列表.md)。

## 核心流程

1. 上传 Excel / Word / PDF。
2. 手动选择已有解析规则，或新建规则并由 LLM 生成推荐规则。
3. 在页面中编辑 JSON 规则并试解析。
4. 进入类 Excel 预览页，实时校验、标红、删除行、新增行、导出 Excel。
5. 提交前再次在服务端校验，使用 Prisma 事务写入数据库。
6. 已导入运单页从数据库分页读取，支持外部编码、收件人、门店、时间筛选。

## 规则引擎能力

规则 DSL 位于 `src/lib/types.ts`，执行器位于 `src/lib/parser-engine.ts`。当前支持：

- `table`：标准表格、跳过干扰头、合计行终止、尾部标签元信息。
- `matrix`：SKU 行与门店列的矩阵转置。
- `grid`：门店/日期网格与复合单元格拆分。
- `cards`：纵向卡片边界识别和卡片内小表解析。
- `text-sequence`：PDF/Word 文本中按 SKU 编码附近连续行抽取。
- `text-regex`：按分隔线拆记录，再用正则抽取上下文和物品行。

9 类考试文件的规则 JSON 示例见 `docs/rule-examples.json`。

## 校验与聚合

- SKU 编码、SKU 名称、发货数量必填，数量必须为正数。
- 收货门店，或收件人姓名 + 电话 + 地址二选一必填。
- 电话格式校验。
- 同一外部编码且收货信息一致时视为同一出库单多 SKU，预览页聚合展示并给提示。
- 同一外部编码但收货信息冲突时阻断提交。
- 与数据库历史外部编码重复时阻断提交。

## 验证命令

```bash
npx tsc --noEmit
npm run lint
npx prisma validate
npm run build
```

可用 `AI考试附件` 中的 Excel / PDF 文件在首页上传测试。LLM 网关异常时，后端会返回本地结构分析生成的推荐规则，并在规则 notes 中标注降级原因。
