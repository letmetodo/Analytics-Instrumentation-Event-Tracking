# ABI Ruby 服务端 SDK (`abi_sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi_sdk` 是 **ABI 企业级用户行为分析（UBA）与 BI 平台** 的官方 Ruby 服务端数据采集 SDK（API 设计对标数数科技 ThinkingData Ruby Server SDK v3.4）。SDK 100% 基于 Ruby 标准库构建（**零第三方 Gem 依赖**，兼容 Ruby 2.6+ / 3.x），内置完整的身份标识与属性规范化校验、超 `2^53 - 1` 64 位雪花 ID 精度保护以及四种可插拔传输通道（Consumer）。

---

## 1. 核心特性与四大 Consumer 架构

### 核心特性
- **零第三方依赖（兼容 Ruby 2.6+ / 3.x）**：仅使用 Ruby 标准库（`json`、`net/http`、`zlib`、`securerandom`、`time`），无需额外安装第三方 Gem。
- **双命名风格兼容**：同时支持 Ruby 社区惯用的 `snake_case`（如 `set_super_properties`、`track`、`user_set`）与跨语言统一的 `camelCase`（如 `setSuperProperties`、`track`、`userSet`）。（*注：按 D7① / G6 门禁，`track_first` / `track_update` / `track_overwrite` 当前版本未开放*）。
- **客户端前置强校验与双 ID 契约（对标数数科技 ThinkingData）**：本地自动执行身份标识归一化（拦截 `0x00–0x08`、`0x0E–0x1F`、`0x7F` 控制字符，裁剪首尾 Unicode 空白符并保留内部全角空格 `U+3000`，严格校验 UTF-8 字节上限：`distinct_id` / `event_id` ≤ 64 字节，`login_id` ≤ 128 字节；`distinct_id` 与 `login_id` 至少一个非空，绝不将 `login_id` 回填到 `distinct_id`）及事件名/属性键白名单与正则校验。任一事件或画像操作同时携带非空 `account_id`（`login_id`）与 `distinct_id` 时，下游 Flink 自动完成全链路 ID-Mapping 关联。
- **64 位雪花 ID 精度安全（`> 2^53 - 1` 自动转十进制字符串）**：对绝对值超过 IEEE-754 双精度安全整数上限（`9007199254740991`）的整数属性值（含一维数组元素），自动序列化为十进制字符串，防止前端 JS 或跨语言 JSON 解析丢失低位精度。
- **静态与动态公共属性分层合并**：严格遵循 `静态公共属性 < 动态公共属性 < 单次事件属性` 覆盖优先级，并在 `$user_*` / `#user_*` 用户画像操作中自动隔离公共属性。
- **`#time` / `$time` 与 `#ip` / `$ip` 预置字段支持**：支持在 `properties` 中传入 `#time` 或 `$time`（自动解析为顶层毫秒级 `timestamp` 并从 `properties` 中剥离），以及传入客户端真实 `#ip` / `$ip` 供采集网关与 Flink ETL 解析国家/省/市地域信息。

### 四大 Consumer 架构

| Consumer 类型 | 类名 | 适用场景与核心能力 |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `AbiSdk::StagingConsumer` | **两步式预览与确认提交**：将埋点事件暂存在内存中，先通过 `preview_request_json` 预览即将发送至 `POST /collect/api/v1/track/batch` 的完整格式化 JSON（零网络请求），核对无误后再通过 `submit_to_gateway` 或 `confirm_submit` 正式提交。 |
| **`BatchConsumer`** | `AbiSdk::BatchConsumer` | **生产批量缓冲上报**：支持内存线程安全缓冲队列、按批量条数（`batch_size`，默认 50，最大 500）自动刷盘、Gzip 压缩传输，以及针对 HTTP `429` / `5xx` 的指数退避幂等重试（保留原 `event_id` 确保 StarRocks 去重）。 |
| **`LoggerConsumer`** | `AbiSdk::LoggerConsumer` | **本地 JSONL 轮转落盘（Puma / Unicorn 高并发推荐）**：将事件按行序列化为 JSONL 写入本地磁盘，支持按天（`DAILY`）、按小时（`HOURLY`）及单文件体积上限（`max_file_size_mb`）自动切分轮转，配合 Filebeat / Vector / LogBus 异步采集。 |
| **`DebugConsumer`** | `AbiSdk::DebugConsumer` | **研发期同步 L4 强校验与 `dry_run`**：逐条同步发送事件并开启 `debug=true`（可选 `dry_run: true` 仅校验不落库），遇到 Schema 校验错误立即抛出 `AbiSdk::AbiSdkError`。 |

---

## 2. 安装与引入

```ruby
require_relative '/path/to/abi.sdk/ruby/lib/abi_sdk'
```

---

## 3. Rails / Rack / Sidekiq 服务端接入必读指南（`request.remote_ip` 传 `#ip` / 每次必传身份 / 异步 `#time` / 幂等 `event_id`）

### 3.1 为什么 Ruby 服务端 SDK 与前端 JS / App SDK 传参职责不同？

Ruby 服务端运行在后端 Puma / Unicorn 容器或 Sidekiq 异步队列进程中，是**无状态多用户共享实例**：
1. **每次调用必传用户身份（`account_id` / `distinct_id`）**：服务端不能在全局单例中缓存当前登录用户，每次调用 `track*` / `user_*` 必须显式传入当前请求用户的 `account_id`（`login_id`，≤ 128 UTF-8 字节）与/或前端透传的访客 ID `distinct_id`（≤ 64 UTF-8 字节），至少一个非空（纯后端任务仅传 `account_id` 时 `distinct_id` 传 `''` 即可，SDK 不会将 `account_id` 拷贝至 `distinct_id`）。
2. **从 Rails `request.remote_ip`（或 Rack `HTTP_X_FORWARDED_FOR`）提取真实客户端 IP 传入 `#ip`**：当 Ruby 服务器请求 `:8081` 采集网关时，网关 TCP 连接看到的是**后端机房内网 IP**（使用 `LoggerConsumer` 落盘时更无连接 IP）。若不显式传 `#ip`，所有服务端埋点的国家/省份/城市都会变成机房所在地！
3. **Sidekiq / ActiveJob 异步任务必传 `#time` 与幂等 `event_id`**：异步任务执行时间晚于实际业务发生时间，且 Sidekiq 失败重试会重放同一 Job，必须显式传入实际业务发生时间 `#time` 与确定性业务主键 `event_id`（如 `"ord_paid_#{order.order_no}"`）。

### 3.2 Rails Controller 与 Sidekiq Worker 最佳实践示例

```ruby
require_relative 'lib/abi_sdk'

# 在 Rails ApplicationController 中提取客户端真实 IP 与前端透传的访客 ID (distinct_id)
module AbiTrackingHelper
  def extract_client_ip(request)
    # Rails ActionDispatch::Request#remote_ip 已自动处理受信任反向代理的 X-Forwarded-For
    return request.remote_ip if request.respond_to?(:remote_ip) && !request.remote_ip.to_s.empty?

    xff = request.env['HTTP_X_FORWARDED_FOR'].to_s
    return xff.split(',').first.strip unless xff.empty?

    request.env['HTTP_X_REAL_IP'].to_s.strip
  end

  def extract_distinct_id(request)
    request.env['HTTP_X_ABI_DISTINCT_ID'].to_s.strip
  end
end
```

---

## 4. 代码示例

### 4.1 两步式预览请求 JSON 与确认提交（`StagingConsumer`）

```ruby
require_relative 'lib/abi_sdk'

# 第 1 步：创建 StagingConsumer 在内存中录制事件并预览完整请求 JSON（零网络请求）
staging = AbiSdk::StagingConsumer.new(project_id: 1, project_token: 'abi_tok_demo_ruby', dry_run: false)
sdk = AbiSdk::AbiAnalytics.new(staging)

sdk.set_super_properties(
  '$platform' => 'RubyServer',
  'service_name' => 'order-service'
)

sdk.track('acct_900102', 'anon_dev_7f8e9a01', 'OrderPaid', {
  '#ip' => '203.0.113.42',            # 从 Rails request.remote_ip 提取的客户端真实公网 IP
  'order_id' => 9_007_199_254_740_999, # > 2^53-1 雪花 ID，SDK 自动转为字符串 "9007199254740999"
  'order_no' => 'ORD-20261110-8801',
  'amount' => 2549.15
})

puts '=== 待提交请求 JSON 预览 ==='
puts staging.preview_request_json

# 第 2 步：确认无误后提交至采集网关（或通过 staging.confirm_submit(batch_consumer) 投递给目标 Consumer）
resp = staging.submit_to_gateway(server_url: 'http://127.0.0.1:8081', compress_gzip: true)
puts '=== 提交响应结果 ==='
puts JSON.pretty_generate(resp)
```

### 4.2 完整生产功能示例（公共属性、双 ID 自动关联、Sidekiq 幂等事件与 7 类用户画像操作）

```ruby
require_relative 'lib/abi_sdk'

consumer = AbiSdk::BatchConsumer.new(
  server_url: 'http://127.0.0.1:8081',
  project_id: 1,
  project_token: 'abi_tok_prod_xxx',
  batch_size: 50,
  compress_gzip: true,
  max_retries: 3
)
sdk = AbiSdk::AbiAnalytics.new(consumer)

# 1. 静态与动态公共属性管理（自动隔离 $user_* 画像事件）
sdk.set_super_properties('$platform' => 'RubyServer', 'service_name' => 'checkout-api')
sdk.set_dynamic_super_properties do
  { 'server_region' => 'ap-shanghai', 'ruby_version' => RUBY_VERSION }
end

account_id = 'acct_900102'
visitor_id = 'vis_dev_7f8e9a01'
client_ip = '203.0.113.42'

# 2. 登录事件同时携带 account_id (login_id) 与 visitor_id (distinct_id)，Flink 自动完成 ID-Mapping 关联
sdk.track(account_id, visitor_id, '$login', { '#ip' => client_ip, 'login_method' => 'sso_oidc' })

# 3. Sidekiq 异步消费幂等上报（显式指定 event_id、distinct_id 与实际发生时间 #time）
sdk.track_with_options(
  event_id: 'ord_paid_ORD-20261110-8801',
  event_name: 'OrderPaid',
  account_id: account_id,
  distinct_id: visitor_id,
  properties: {
    '#ip' => client_ip,
    '#time' => '2026-11-10T10:00:00Z', # 自动提取为顶层毫秒 timestamp 并从 properties 剥离
    'order_id' => 9_007_199_254_740_999,
    'amount' => 2549.15
  }
)

# 注：按 D7① / G6 门禁，track_first / track_update / track_overwrite 当前版本未开放（调用会抛出 AbiSdkError 且不入队）；状态推进请上报独立里程碑事件
sdk.track_with_options(
  event_id: 'ord_fulfilled_ORD-20261110-8801',
  event_name: 'OrderFulfilled',
  account_id: account_id,
  distinct_id: visitor_id,
  properties: { '#ip' => client_ip, 'order_status' => 'FULFILLED' }
)

# 4. 全部 7 类用户画像操作（$user_set / $user_set_once / $user_add / $user_append / $user_uniq_append / $user_unset / $user_del）
sdk.user_set(account_id, visitor_id, { 'plan_tier' => 'Enterprise', 'seat_count' => 50 })
sdk.user_set_once(account_id, visitor_id, { 'first_utm_source' => 'google_sem' })
sdk.user_add(account_id, visitor_id, { 'cumulative_payment' => 2549.15, 'order_count' => 1 })
sdk.user_append(account_id, visitor_id, { 'enabled_modules' => %w[event_analysis funnel_analysis] })
sdk.user_uniq_append(account_id, visitor_id, { 'enabled_modules' => %w[funnel_analysis retention_analysis] })
sdk.user_unset(account_id, visitor_id, 'legacy_trial_tag', 'temp_flag')
# sdk.user_delete(account_id, visitor_id)

sdk.close
```

---

## 5. 验证与运行 CLI Demo

```bash
# 运行黄金测试向量契约与全量单元测试
/usr/bin/ruby /Users/zhongjie/data/anylink/abi/abi.sdk/ruby/test/abi_sdk_test.rb

# 运行两步式 CLI Demo（第 1 步预览请求 JSON，第 2 步自动确认并输出响应 JSON）
/usr/bin/ruby /Users/zhongjie/data/anylink/abi/abi.sdk/ruby/examples/demo.rb --yes
```
