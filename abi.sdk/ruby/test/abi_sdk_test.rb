#!/usr/bin/env ruby
# frozen_string_literal: true

# ABI Ruby 服务端 SDK 单元测试与跨语言黄金测试向量契约验证套件。

require 'tmpdir'
require_relative '../lib/abi_sdk'
require_relative '../examples/demo'

class AbiRubySdkTestRunner
  def initialize
    @assertions = 0
  end

  def assert_true(cond, message)
    @assertions += 1
    raise "Assertion failed: #{message}" unless cond
  end

  def assert_equal(expected, actual, message)
    @assertions += 1
    return if expected == actual

    raise "#{message}\n  expected: #{expected.inspect}\n  actual:   #{actual.inspect}"
  end

  def assert_raises(message)
    @assertions += 1
    begin
      yield
    rescue StandardError
      return
    end
    raise "Expected exception was not raised: #{message}"
  end

  def run_all
    test_golden_identity_vectors
    test_golden_event_and_property_vectors
    test_big_int_precision_and_sanitization
    test_time_extraction_and_stripping
    test_super_properties_and_user_isolation
    test_all_track_and_user_profile_methods
    test_batch_and_debug_consumers
    test_logger_consumer_rotation
    test_two_step_demo_preview_and_confirm

    $stdout.puts "[PASS] ABI Ruby SDK all tests passed (#{@assertions} assertions verified)."
  end

  private

  def test_golden_identity_vectors
    path = File.expand_path('../../spec/test-vectors/identity_cases.json', __dir__)
    spec = JSON.parse(File.read(path, encoding: 'UTF-8'))

    max_distinct = spec['max_distinct_id_bytes'].to_i
    max_login = spec['max_login_id_bytes'].to_i

    spec['cases'].each do |c|
      name = c['name']
      if c['valid']
        norm_distinct = AbiSdk::Validator.normalize_identity(c['distinct_id'].to_s, max_distinct)
        norm_login = AbiSdk::Validator.normalize_identity(c['login_id'].to_s, max_login)
        assert_true(!(norm_distinct.empty? && norm_login.empty?), "identity case #{name} at least one non-empty")

        assert_equal(c['normalized_distinct_id'], norm_distinct, "identity case #{name} distinct_id")
        assert_equal(c['normalized_login_id'], norm_login, "identity case #{name} login_id")
      else
        assert_raises("identity invalid case #{name} must be rejected") do
          d = AbiSdk::Validator.normalize_identity(c['distinct_id'].to_s, max_distinct)
          l = AbiSdk::Validator.normalize_identity(c['login_id'].to_s, max_login)
          raise AbiSdk::AbiSdkError, 'empty identities' if d.empty? && l.empty?
        end
      end
    end
  end

  def test_golden_event_and_property_vectors
    path = File.expand_path('../../spec/test-vectors/event_and_property_cases.json', __dir__)
    spec = JSON.parse(File.read(path, encoding: 'UTF-8'))

    assert_equal(9_007_199_254_740_991, spec['max_safe_integer'].to_i, 'max_safe_integer constant')

    spec['event_name_cases'].each do |c|
      evt_name = c['event_name'].to_s
      if c['valid']
        assert_equal(evt_name, AbiSdk::Validator.validate_event_name(evt_name), "valid event_name #{evt_name}")
      else
        assert_raises("invalid event_name #{evt_name}") do
          AbiSdk::Validator.validate_event_name(evt_name)
        end
      end
    end

    spec['property_key_cases'].each do |c|
      key = c['key'].to_s
      if c['valid']
        assert_equal(key, AbiSdk::Validator.validate_property_key(key), "valid property key #{key}")
      else
        assert_raises("invalid property key #{key}") do
          AbiSdk::Validator.validate_property_key(key)
        end
      end
    end
  end

  def test_big_int_precision_and_sanitization
    staging = AbiSdk::StagingConsumer.new(project_id: 1, project_token: 'abi_tok_test')
    sdk = AbiSdk::AbiAnalytics.new(staging)

    sdk.track('u_1001', 'anon_1001', 'OrderPaid', {
      'safe_int' => 9_007_199_254_740_991,
      'neg_safe_int' => -9_007_199_254_740_991,
      'snowflake_id' => 9_007_199_254_740_993,
      'neg_unsafe_int' => -9_007_199_254_740_993,
      'min_int64' => -9_223_372_036_854_775_808,
      'id_list' => [100, 9_007_199_254_740_999],
      'null_field' => nil
    })

    events = staging.events
    assert_equal(1, events.length, 'single tracked event')
    props = events.first.properties

    assert_equal(9_007_199_254_740_991, props['safe_int'], 'safe_int stays integer')
    assert_equal(-9_007_199_254_740_991, props['neg_safe_int'], 'neg_safe_int stays integer')
    assert_equal('9007199254740993', props['snowflake_id'], '> 2^53-1 converted to string')
    assert_equal('-9007199254740993', props['neg_unsafe_int'], '< -(2^53-1) converted to string')
    assert_equal('-9223372036854775808', props['min_int64'], 'min int64 converted to string')
    assert_equal([100, '9007199254740999'], props['id_list'], 'list big int converted to string')
    assert_true(!props.key?('null_field'), 'nil property ignored')

    assert_raises('reject Float::NAN') { sdk.track('u_1', 'a_1', 'Evt', { 'bad' => Float::NAN }) }
    assert_raises('reject Float::INFINITY') { sdk.track('u_1', 'a_1', 'Evt', { 'bad' => Float::INFINITY }) }
    assert_raises('reject nil in list') { sdk.track('u_1', 'a_1', 'Evt', { 'bad' => ['ok', nil] }) }
    assert_raises('reject nested hash') { sdk.track('u_1', 'a_1', 'Evt', { 'bad' => { 'nested' => 1 } }) }
  end

  def test_time_extraction_and_stripping
    staging = AbiSdk::StagingConsumer.new(project_id: 1, project_token: 'abi_tok_test')
    sdk = AbiSdk::AbiAnalytics.new(staging)

    sdk.track('u_1001', 'anon_1001', 'AsyncCallback', {
      '#time' => '2026-11-10T12:00:00Z',
      '$time' => '2026-11-09T12:00:00Z',
      '#ip' => '203.0.113.88',
      'amount' => 99.5
    })

    evt = staging.events.first
    assert_equal(1_794_312_000_000, evt.timestamp, '#time overrides $time and sets top-level timestamp ms')
    assert_true(!evt.properties.key?('#time'), '#time stripped from properties')
    assert_true(!evt.properties.key?('$time'), '$time stripped from properties')
    assert_equal('203.0.113.88', evt.properties['#ip'], '#ip preserved in properties')
  end

  def test_super_properties_and_user_isolation
    staging = AbiSdk::StagingConsumer.new(project_id: 1, project_token: 'abi_tok_test')
    sdk = AbiSdk::AbiAnalytics.new(staging)

    sdk.setSuperProperties({
      '$platform' => 'RubyServer',
      'env' => 'prod',
      'override_key' => 'from_static',
      'temp_key' => 'remove_me'
    })
    sdk.unsetSuperProperty('temp_key')
    assert_true(!sdk.getSuperProperties.key?('temp_key'), 'unsetSuperProperty works')

    sdk.setDynamicSuperProperties(-> { { 'override_key' => 'from_dynamic', 'dyn_only' => 'yes' } })

    long_login_id = 'u' * 100
    sdk.track(long_login_id, '', 'Purchase', { 'override_key' => 'from_event' })
    sdk.userSet('u_1001', '', { 'vip_level' => 5 })

    track_evt, user_evt = staging.events
    assert_equal('', track_evt.distinct_id, 'empty distinct_id is never copied from login_id')
    assert_equal(long_login_id, track_evt.login_id, '100-byte login_id preserved')
    assert_equal('from_event', track_evt.properties['override_key'], 'event overrides dynamic and static')
    assert_equal('yes', track_evt.properties['dyn_only'], 'dynamic super property merged')
    assert_equal('RubyServer', track_evt.properties['$platform'], 'static super property merged')
    assert_equal({ 'vip_level' => 5 }, user_evt.properties, '$user_set isolates super properties')

    sdk.clearSuperProperties
    assert_equal({}, sdk.getSuperProperties, 'clearSuperProperties empties super properties')
  end

  def test_all_track_and_user_profile_methods
    staging = AbiSdk::StagingConsumer.new(project_id: 1, project_token: 'abi_tok_test', dry_run: true)
    sdk = AbiSdk::AbiAnalytics.new(staging)

    sdk.track('acc_1', 'vis_1', '$login', { 'method' => 'sso' })
    sdk.track_with_options(
      event_id: 'evt_ord_1',
      account_id: 'acc_1',
      distinct_id: 'vis_1',
      event_name: 'OrderPaid',
      properties: { 'status' => 'PAID' }
    )

    assert_raises('trackFirst rejects unsupported call') do
      sdk.trackFirst('acc_1', 'vis_1', 'FirstActivate', 'chk_001', { 'channel' => 'web' })
    end
    assert_raises('trackUpdate rejects unsupported call') do
      sdk.trackUpdate('acc_1', 'vis_1', 'OrderLifecycle', 'evt_ord_1', { 'status' => 'PAID' })
    end
    assert_raises('trackOverwrite rejects unsupported call') do
      sdk.trackOverwrite('acc_1', 'vis_1', 'OrderLifecycle', 'evt_ord_1', { 'status' => 'SETTLED' })
    end

    sdk.userSet('acc_1', 'vis_1', { 'tier' => 'Pro' })
    sdk.userSetOnce('acc_1', 'vis_1', { 'first_channel' => 'organic' })
    sdk.userAdd('acc_1', 'vis_1', { 'points' => 10 })
    sdk.userAppend('acc_1', 'vis_1', { 'tags' => %w[a b] })
    sdk.userUniqAppend('acc_1', 'vis_1', { 'tags' => %w[b c] })
    sdk.userUnset('acc_1', 'vis_1', 'temp_flag', 'old_badge')
    sdk.userDelete('acc_1', 'vis_1')

    events = staging.events
    assert_equal(9, events.length, 'all 9 valid events recorded')
    assert_equal('$login', events[0].event_name, 'dual-ID $login event')
    assert_equal('vis_1', events[0].distinct_id, 'dual-ID distinct_id')
    assert_equal('acc_1', events[0].login_id, 'dual-ID login_id')
    assert_equal('evt_ord_1', events[1].event_id, 'track_with_options preserves event_id')
    assert_equal('$user_set', events[2].event_name, 'userSet event_name')
    assert_equal('$user_set_once', events[3].event_name, 'userSetOnce event_name')
    assert_equal('$user_add', events[4].event_name, 'userAdd event_name')
    assert_equal('$user_append', events[5].event_name, 'userAppend event_name')
    assert_equal('$user_uniq_append', events[6].event_name, 'userUniqAppend event_name')
    assert_equal('$user_unset', events[7].event_name, 'userUnset event_name')
    assert_equal({ 'temp_flag' => 0, 'old_badge' => 0 }, events[7].properties, 'userUnset keys')
    assert_equal('$user_del', events[8].event_name, 'userDelete emits $user_del')

    assert_raises('userAdd rejects string value') do
      sdk.userAdd('acc_1', 'anon_1', { 'bad_str' => '100' })
    end
  end

  def test_batch_and_debug_consumers
    attempts = 0
    received_payloads = []

    AbiSdk::HttpBatchSender.custom_transport = lambda do |_endpoint, headers, body_bytes, _timeout|
      attempts += 1
      raw_json =
        if headers['Content-Encoding'] == 'gzip'
          Zlib::GzipReader.new(StringIO.new(body_bytes)).read
        else
          body_bytes
        end
      decoded = JSON.parse(raw_json)
      received_payloads << decoded

      return [429, '{"code":32060,"message":"rate limit exceeded"}', nil] if attempts == 1

      if decoded['debug'] && decoded['events'].first['event_name'] == 'TriggerDebugReject'
        return [200, JSON.generate({
          'code' => 200,
          'message' => 'success',
          'request_id' => 'req_dbg_err',
          'data' => {
            'accepted' => 0,
            'rejected' => 1,
            'errors' => [{ 'index' => 0, 'reason' => 'property type mismatch in L4 schema' }]
          }
        }), nil]
      end

      [200, JSON.generate({
        'code' => 200,
        'message' => 'success',
        'request_id' => 'req_batch_ok',
        'data' => {
          'accepted' => decoded['events'].length,
          'rejected' => 0
        }
      }), nil]
    end

    begin
      batch_consumer = AbiSdk::BatchConsumer.new(
        server_url: 'http://127.0.0.1:8081',
        project_id: 1,
        project_token: 'abi_tok_batch',
        batch_size: 2,
        compress_gzip: true,
        max_retries: 2
      )
      sdk = AbiSdk::AbiAnalytics.new(batch_consumer)
      sdk.track('u_1', 'anon_1', 'EventOne', { 'step' => 1 })
      sdk.track('u_1', 'anon_1', 'EventTwo', { 'step' => 2 })

      assert_equal(2, attempts, 'BatchConsumer retried once after 429 and succeeded')
      assert_equal(
        received_payloads[0]['events'][0]['event_id'],
        received_payloads[1]['events'][0]['event_id'],
        'event_id preserved across 429 retry'
      )

      debug_consumer = AbiSdk::DebugConsumer.new(
        server_url: 'http://127.0.0.1:8081',
        project_id: 1,
        project_token: 'abi_tok_dbg',
        dry_run: true
      )
      dbg_sdk = AbiSdk::AbiAnalytics.new(debug_consumer)
      dbg_sdk.track('u_1', 'anon_1', 'ValidDebugEvent', { 'ok' => true })

      assert_raises('DebugConsumer raises when gateway reports rejected > 0') do
        dbg_sdk.track('u_1', 'anon_1', 'TriggerDebugReject', { 'bad' => 1 })
      end
    ensure
      AbiSdk::HttpBatchSender.custom_transport = nil
    end
  end

  def test_logger_consumer_rotation
    Dir.mktmpdir('abi_ruby_sdk_test_') do |tmp_dir|
      logger = AbiSdk::LoggerConsumer.new(
        directory: tmp_dir,
        file_prefix: 'abi.log',
        rotate_mode: AbiSdk::LoggerConsumer::ROTATE_DAILY,
        now_proc: -> { Time.utc(2026, 11, 10, 8, 0, 0) }
      )
      sdk = AbiSdk::AbiAnalytics.new(logger)
      sdk.track('u_log_1', 'anon_log_1', 'ServerBooted', { 'port' => 3000 })
      sdk.close

      expected_file = File.join(tmp_dir, 'abi.log.2026-11-10')
      assert_true(File.file?(expected_file), 'logger file created')
      lines = File.readlines(expected_file, chomp: true).reject(&:empty?)
      assert_equal(1, lines.length, 'one JSONL line written')
    end
  end

  def test_two_step_demo_preview_and_confirm
    preview_json, staging = AbiRubyDemo.build_demo_request_preview(
      project_id: 1,
      token: 'abi_tok_demo_ruby',
      scenario: 'all',
      super_props: AbiRubyDemo::DEFAULT_SUPER_PROPS_JSON,
      dynamic_super: true,
      dry_run: true
    )

    decoded_req = JSON.parse(preview_json)
    assert_equal(1, decoded_req['project_id'], 'demo preview project_id')
    assert_equal(true, decoded_req['dry_run'], 'demo preview dry_run')
    assert_equal(14, decoded_req['events'].length, 'demo all scenario contains 14 events')

    resp_json = AbiRubyDemo.confirm_submit_demo(staging, { server_url: '' })
    decoded_resp = JSON.parse(resp_json)
    assert_equal(200, decoded_resp['code'], 'demo response code 200')
    assert_equal(14, decoded_resp['data']['accepted'], 'demo response accepted 14')
  end
end

AbiRubySdkTestRunner.new.run_all
