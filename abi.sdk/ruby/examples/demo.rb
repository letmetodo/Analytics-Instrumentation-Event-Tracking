#!/usr/bin/env ruby
# frozen_string_literal: true

# ABI Ruby 服务端 SDK 两步式交互演示程序（CLI Demo）：
# 第 1 步：配置参数并在内存中生成唯一一份 `POST /collect/api/v1/track/batch` 请求 JSON 预览（零网络请求）；
# 第 2 步：支持 `--yes` 自动确认或终端交互输入 `y` 确认提交，并打印单份采集网关响应 JSON。

require_relative '../lib/abi_sdk'

module AbiRubyDemo
  DEFAULT_SUPER_PROPS_JSON = '{"$app_version":"2.5.0","$platform":"RubyServer","service_name":"order-service"}'

  module_function

  def parse_demo_args(argv)
    cfg = {
      server_url: '',
      project_id: 1,
      token: 'abi_tok_demo_ruby',
      scenario: 'order',
      super_props: DEFAULT_SUPER_PROPS_JSON,
      dynamic_super: true,
      dry_run: false,
      yes: false
    }

    argv.each do |arg|
      if arg == '--yes' || arg == '-y'
        cfg[:yes] = true
      elsif arg == '--dry-run'
        cfg[:dry_run] = true
      elsif arg == '--no-dynamic-super'
        cfg[:dynamic_super] = false
      elsif arg.start_with?('--server-url=')
        cfg[:server_url] = arg.sub('--server-url=', '').strip
      elsif arg.start_with?('--project-id=')
        cfg[:project_id] = arg.sub('--project-id=', '').to_i
      elsif arg.start_with?('--token=')
        cfg[:token] = arg.sub('--token=', '').strip
      elsif arg.start_with?('--scenario=')
        cfg[:scenario] = arg.sub('--scenario=', '').strip.downcase
      elsif arg.start_with?('--super-props=')
        cfg[:super_props] = arg.sub('--super-props=', '').strip
      end
    end

    cfg
  end

  # 第 1 步：根据演示参数构造 `StagingConsumer` 并录制对应场景的埋点事件，返回格式化请求 JSON 与暂存器
  def build_demo_request_preview(cfg)
    project_id = (cfg[:project_id] || 1).to_i
    token = (cfg[:token] || 'abi_tok_demo_ruby').to_s
    dry_run = !!cfg[:dry_run]

    staging = AbiSdk::StagingConsumer.new(project_id: project_id, project_token: token, dry_run: dry_run)
    sdk = AbiSdk::AbiAnalytics.new(staging)

    super_props_json = (cfg[:super_props] || '').to_s.strip
    if !super_props_json.empty? && super_props_json != '{}'
      decoded = JSON.parse(super_props_json)
      sdk.set_super_properties(decoded) if decoded.is_a?(Hash) && !decoded.empty?
    end

    if cfg[:dynamic_super]
      sdk.set_dynamic_super_properties do
        {
          'server_region' => 'ap-shanghai',
          'ruby_version' => RUBY_VERSION
        }
      end
    end

    scenario = (cfg[:scenario] || 'order').to_s.strip.downcase
    scenario = 'order' if scenario.empty?

    case scenario
    when 'browse'
      trigger_anonymous_browse_demo(sdk)
    when 'identity'
      trigger_login_identity_bind_demo(sdk)
    when 'order'
      trigger_order_lifecycle_demo(sdk)
    when 'profile'
      trigger_user_profile_demo(sdk)
    when 'all'
      trigger_anonymous_browse_demo(sdk)
      trigger_login_identity_bind_demo(sdk)
      trigger_order_lifecycle_demo(sdk)
      trigger_user_profile_demo(sdk)
    else
      raise AbiSdk::AbiSdkError, "未知的 --scenario 参数值 #{scenario.inspect}（可选值：browse | identity | order | profile | all）"
    end

    [staging.preview_request_json, staging]
  end

  def trigger_anonymous_browse_demo(sdk)
    visitor_id = 'vis_dev_7f8e9a01'
    sdk.track('', visitor_id, '$pageview', {
      '#ip' => '203.0.113.42',
      '$url' => 'https://store.example.com/products/bi-enterprise',
      '$url_path' => '/products/bi-enterprise',
      '$title' => 'ABI Enterprise Edition',
      '$referrer' => 'https://www.google.com'
    })
    sdk.track('', visitor_id, 'ProductViewed', {
      '#ip' => '203.0.113.42',
      'product_id' => 'sku_abi_ent_2026',
      'product_name' => 'ABI Enterprise Analytics Suite',
      'category' => 'SaaS',
      'price' => 2999.00
    })
  end

  def trigger_login_identity_bind_demo(sdk)
    account_id = 'acct_900102'
    visitor_id = 'vis_dev_7f8e9a01'
    sdk.track(account_id, visitor_id, '$signup', {
      '#ip' => '203.0.113.42',
      'register_channel' => 'sso_oidc'
    })
    sdk.track(account_id, visitor_id, '$login', {
      '#ip' => '203.0.113.42',
      'login_method' => 'sso_oidc',
      'mfa_verified' => true
    })
  end

  def trigger_order_lifecycle_demo(sdk)
    account_id = 'acct_900102'
    visitor_id = 'vis_dev_7f8e9a01'
    snowflake_order_id = 9_007_199_254_740_999 # 超过 2^53 - 1 (9007199254740991)，SDK 自动序列化为十进制字符串

    sdk.track_with_options(
      event_id: 'ord_created_20261110_8801',
      event_name: 'OrderCreated',
      account_id: account_id,
      distinct_id: visitor_id,
      properties: {
        '#ip' => '203.0.113.42',
        '#time' => '2026-11-10T10:00:00Z',
        'order_no' => 'ORD-20261110-8801',
        'snowflake_id' => snowflake_order_id,
        'order_status' => 'CREATED',
        'payable_amount' => 2999.00,
        'item_sku_list' => %w[sku_abi_ent_2026 sku_addon_flink],
        'sub_task_ids' => [1001, 9_007_199_254_741_024]
      }
    )

    sdk.track_with_options(
      event_id: 'ord_paid_20261110_8801',
      event_name: 'OrderPaid',
      account_id: account_id,
      distinct_id: visitor_id,
      properties: {
        '#ip' => '203.0.113.42',
        'order_no' => 'ORD-20261110-8801',
        'snowflake_id' => snowflake_order_id,
        'order_status' => 'PAID',
        'payable_amount' => 2549.15,
        'coupon_code' => 'FIRST_ORDER_50',
        'discount_rate' => 0.85,
        'payment_channel' => 'stripe_enterprise'
      }
    )

    sdk.track_with_options(
      event_id: 'ord_fulfilled_20261110_8801',
      event_name: 'OrderFulfilled',
      account_id: account_id,
      distinct_id: visitor_id,
      properties: {
        '#ip' => '203.0.113.42',
        'order_no' => 'ORD-20261110-8801',
        'snowflake_id' => snowflake_order_id,
        'order_status' => 'FULFILLED',
        'payable_amount' => 2549.15,
        'invoice_issued' => true
      }
    )
  end

  def trigger_user_profile_demo(sdk)
    account_id = 'acct_900102'
    visitor_id = 'vis_dev_7f8e9a01'

    sdk.user_set(account_id, visitor_id, {
      'company_name' => 'Acme Analytics Corp',
      'plan_tier' => 'Enterprise',
      'seat_count' => 50,
      '$city' => 'Shanghai'
    })
    sdk.user_set_once(account_id, visitor_id, {
      'first_utm_source' => 'github_release',
      'activated_at' => Time.utc(2026, 11, 10, 10, 0, 0)
    })
    sdk.user_add(account_id, visitor_id, {
      'cumulative_payment' => 2549.15,
      'order_count' => 1
    })
    sdk.user_append(account_id, visitor_id, {
      'enabled_modules' => %w[event_analysis funnel_analysis]
    })
    sdk.user_uniq_append(account_id, visitor_id, {
      'enabled_modules' => %w[funnel_analysis retention_analysis sql_ide]
    })
    sdk.user_unset(account_id, visitor_id, 'legacy_trial_tag', 'onboarding_banner_dismissed')
    sdk.user_delete('acct_gdpr_erased_01', 'vis_gdpr_erased_01')
  end

  # 第 2 步：确认提交后将请求发送至采集网关（未指定 `--server-url` 时自动通过内置本地回执模拟网关响应）
  def confirm_submit_demo(staging, cfg)
    server_url = (cfg[:server_url] || '').to_s.strip
    unless server_url.empty?
      resp = staging.submit_to_gateway(server_url: server_url, compress_gzip: true)
      return JSON.pretty_generate(resp)
    end

    payload = staging.build_request_payload
    events_count = payload['events'].is_a?(Array) ? payload['events'].length : 0
    envelope = {
      'code' => 200,
      'message' => 'success',
      'request_id' => 'req_mock_ruby_1',
      'data' => {
        'accepted' => events_count,
        'rejected' => 0,
        'dry_run' => !!payload['dry_run']
      }
    }
    JSON.pretty_generate(envelope)
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    cfg = AbiRubyDemo.parse_demo_args(ARGV)
    preview_json, staging = AbiRubyDemo.build_demo_request_preview(cfg)

    $stdout.puts '=== 待提交请求 JSON 预览 (POST /collect/api/v1/track/batch) ==='
    $stdout.puts preview_json

    if !cfg[:yes] && $stdin.tty?
      $stdout.print "\n是否确认提交上述请求参数？输入 y 回车确认提交，其他键取消: "
      $stdout.flush
      line = $stdin.gets
      if line.nil? || line.strip.downcase != 'y'
        $stdout.puts '已取消提交，未向采集网关发送任何请求。'
        exit(0)
      end
    end

    resp_json = AbiRubyDemo.confirm_submit_demo(staging, cfg)
    $stdout.puts "\n=== 提交响应结果 (Response JSON) ==="
    $stdout.puts resp_json
  rescue StandardError => e
    $stderr.puts "[错误] #{e.message}"
    exit(1)
  end
end
