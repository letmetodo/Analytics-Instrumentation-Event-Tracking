# frozen_string_literal: true

require 'date'
require 'fileutils'
require 'json'
require 'net/http'
require 'securerandom'
require 'stringio'
require 'time'
require 'uri'
require 'zlib'

# ABI Ruby 服务端数据采集 SDK（零第三方依赖，基于 Ruby 标准库，兼容 Ruby 2.6+）。
#
# 设计对标数数科技 ThinkingData Ruby Server SDK v3.4，并与 ABI 采集网关
# （`POST /collect/api/v1/track/batch`）及 Flink/StarRocks 实时湖仓契约严格对齐：
# - 完整双 ID 身份标识归一化：控制字符拦截、UTF-8 编码与字节上限校验（`distinct_id` ≤ 64 字节、`login_id` ≤ 128 字节，至少一个非空，绝不回填）；
# - 超 IEEE-754 双精度安全整数范围（`> 2^53 - 1`，即 `9007199254740991`）的大整数自动转为十进制字符串，防止精度丢失；
# - `#time` / `$time` 预置时间属性自动解析为顶层毫秒级 `timestamp` 并从 `properties` 中剥离；
# - 静态公共属性与动态公共属性回调管理（优先级：静态 < 动态 < 单次事件属性），并与 `$user_*` / `#user_*` 画像事件严格隔离；
# - 内置四大传输通道：`StagingConsumer`（两步式请求预览与确认提交）、`BatchConsumer`（批量缓冲 + Gzip + 退避重试）、
#   `LoggerConsumer`（按天/按小时/按文件大小轮转的本地 JSONL 落盘）、`DebugConsumer`（同步 L4 强校验与 `dry_run` 演练）。
module AbiSdk
  MAX_EVENT_ID_BYTES     = 64
  MAX_DISTINCT_ID_BYTES  = 64
  MAX_LOGIN_ID_BYTES     = 128
  MAX_EVENT_NAME_CHARS   = 128
  MAX_CUSTOM_KEY_CHARS   = 64
  MAX_SAFE_INTEGER       = 9_007_199_254_740_991 # 2^53 - 1
  SDK_VERSION            = 'abi-ruby-sdk/1.0.0'

  IDENTIFIER_REGEX = /\A[A-Za-z_][A-Za-z0-9_]*\z/.freeze

  # 系统预置事件白名单
  SYSTEM_EVENT_WHITELIST = [
    '$signup', '$login', '$pageview',
    '$AppStart', '$AppEnd', '$AppClick', '$AppViewScreen',
    '$user_set', '#user_set',
    '$user_set_once', '#user_set_once',
    '$user_add', '#user_add',
    '$user_unset', '#user_unset',
    '$user_append', '#user_append',
    '$user_uniq_append', '#user_uniq_append',
    '$user_del', '#user_del'
  ].each_with_object({}) { |k, h| h[k] = true }.freeze

  # 系统预置属性白名单
  SYSTEM_PROPERTY_WHITELIST = [
    '$os', '#os', 'os',
    '$os_version', '#os_version', 'os_version',
    '$app_version', '#app_version', 'app_version',
    '$browser', '#browser', 'browser',
    '$browser_version', '#browser_version', 'browser_version',
    '$city', '#city', 'city',
    '$province', '#province', 'province',
    '$country', '#country', 'country',
    '$country_code', '#country_code', 'country_code',
    '$ip', '#ip', 'ip',
    '$network', '#network', 'network',
    '$network_type', '#network_type', 'network_type',
    '$platform', '#platform', 'platform',
    '$device_id', '#device_id', 'device_id',
    '$session_id', '#session_id', 'session_id',
    '$screen_width', '#screen_width', 'screen_width',
    '$screen_height', '#screen_height', 'screen_height',
    '$model', '#model', 'model',
    '$device_model', '#device_model', 'device_model',
    '$manufacturer', '#manufacturer', 'manufacturer',
    '$carrier', '#carrier', 'carrier',
    '$url', '#url', 'url',
    '$url_path', '#url_path', 'url_path',
    '$referrer', '#referrer', 'referrer',
    '$title', '#title', 'title',
    '$duration', '#duration', 'duration',
    '$lib', '#lib', 'lib',
    '$lib_version', '#lib_version', 'lib_version',
    '$zone_offset', '#zone_offset', 'zone_offset',
    '$first_check_id', '#first_check_id', 'first_check_id'
  ].each_with_object({}) { |k, h| h[k] = true }.freeze

  # SDK 统一异常基类
  class AbiSdkError < StandardError; end

  # 标识符、事件名、属性键值校验与归一化工具模块
  module Validator
    module_function

    # 判定单个 Unicode 码点是否属于需裁剪的首尾空白字符
    def unicode_whitespace?(cp)
      return true if (cp >= 0x09 && cp <= 0x0D) || cp == 0x20
      return true if cp == 0x0085 || cp == 0x00A0 || cp == 0x1680
      return true if cp >= 0x2000 && cp <= 0x200A
      return true if cp == 0x2028 || cp == 0x2029 || cp == 0x202F || cp == 0x205F || cp == 0x3000

      false
    end

    # 归一化并校验身份标识（distinct_id / login_id / event_id）：
    # 1. 校验合法 UTF-8 编码；
    # 2. 在裁剪前拦截 ASCII 控制字符（0x00–0x08、0x0E–0x1F、0x7F）；
    # 3. 裁剪首尾 Unicode 空白符（保留内部的合法 Unicode 空白符，如全角空格 U+3000）；
    # 4. 校验裁剪后的 UTF-8 字节长度上限。
    def normalize_identity(val, max_utf8_bytes)
      raise AbiSdkError, 'identity must be a String' unless val.is_a?(String)

      s = val.encoding == Encoding::UTF_8 ? val : val.dup.force_encoding(Encoding::UTF_8)
      raise AbiSdkError, 'identity is not valid UTF-8' unless s.valid_encoding?

      codepoints = s.codepoints
      codepoints.each do |cp|
        if (cp < 0x20 && (cp < 0x09 || cp > 0x0D)) || cp == 0x7F
          raise AbiSdkError, format('identity contains control character U+%04X', cp)
        end
      end

      start_idx = 0
      end_idx = codepoints.length - 1
      start_idx += 1 while start_idx <= end_idx && unicode_whitespace?(codepoints[start_idx])
      end_idx -= 1 while end_idx >= start_idx && unicode_whitespace?(codepoints[end_idx])

      trimmed = start_idx > end_idx ? '' : codepoints[start_idx..end_idx].pack('U*')
      if trimmed.bytesize > max_utf8_bytes
        raise AbiSdkError, format(
          'identity exceeds max length of %d UTF-8 bytes (got %d)',
          max_utf8_bytes,
          trimmed.bytesize
        )
      end

      trimmed
    end

    # 校验事件名称（自定义事件名或系统预置事件白名单）
    def validate_event_name(name)
      trimmed = name.to_s.strip
      raise AbiSdkError, 'event_name must not be empty' if trimmed.empty?
      raise AbiSdkError, "event_name exceeds #{MAX_EVENT_NAME_CHARS} characters" if trimmed.length > MAX_EVENT_NAME_CHARS

      return trimmed if SYSTEM_EVENT_WHITELIST.key?(trimmed)

      unless IDENTIFIER_REGEX.match?(trimmed)
        raise AbiSdkError, "invalid event_name #{trimmed.inspect}: must match ^[A-Za-z_][A-Za-z0-9_]*$"
      end

      trimmed
    end

    # 校验属性键名（系统预置属性白名单或不超过 64 字符的自定义属性名）
    def validate_property_key(key)
      trimmed = key.to_s.strip
      raise AbiSdkError, 'property key must not be empty' if trimmed.empty?

      return trimmed if SYSTEM_PROPERTY_WHITELIST.key?(trimmed)

      if trimmed.length > MAX_CUSTOM_KEY_CHARS || !IDENTIFIER_REGEX.match?(trimmed)
        raise AbiSdkError, "invalid property key #{trimmed.inspect}: must match ^[A-Za-z_][A-Za-z0-9_]*$"
      end

      trimmed
    end

    # 清洗并校验属性字典：
    # - 自动忽略 nil 属性值；
    # - 将绝对值 > 2^53 - 1 (9007199254740991) 的大整数自动转为十进制字符串；
    # - 将 Time / DateTime 转为 UTC ISO-8601 字符串；
    # - 拦截 NaN / Infinity 非有限浮点数、嵌套 Hash 及含 nil 的数组元素。
    def sanitize_properties(props)
      return {} if props.nil? || props.empty?
      raise AbiSdkError, 'properties must be a Hash' unless props.is_a?(Hash)

      out = {}
      props.each do |raw_key, raw_val|
        key = validate_property_key(raw_key)
        next if raw_val.nil?

        out[key] = sanitize_property_value(key, raw_val)
      end
      out
    end

    def sanitize_property_value(key, val)
      case val
      when true, false, String
        val
      when Symbol
        val.to_s
      when Integer
        normalize_safe_int(val)
      when Float
        raise AbiSdkError, "property #{key.inspect} has non-finite float value" if val.nan? || val.infinite?

        val
      when Time
        val.dup.utc.iso8601
      when DateTime
        val.new_offset(0).strftime('%Y-%m-%dT%H:%M:%SZ')
      when Array
        val.each_with_index.map do |elem, idx|
          raise AbiSdkError, "property #{key.inspect} list contains nil element at index #{idx}" if elem.nil?

          sanitize_list_element(key, elem)
        end
      else
        raise AbiSdkError, "property #{key.inspect} has unsupported value type #{val.class}"
      end
    end

    def sanitize_list_element(key, elem)
      case elem
      when true, false, String
        elem
      when Symbol
        elem.to_s
      when Integer
        normalize_safe_int(elem)
      when Float
        raise AbiSdkError, "property #{key.inspect} list contains non-finite float" if elem.nan? || elem.infinite?

        elem
      else
        raise AbiSdkError, "property #{key.inspect} list contains unsupported element type #{elem.class}"
      end
    end

    def normalize_safe_int(val)
      return val.to_s if val > MAX_SAFE_INTEGER || val < -MAX_SAFE_INTEGER

      val
    end

    # 从属性 Hash 中检测并剥离 `#time` / `$time` 预置时间字段（不修改调用方原始 Hash）
    def extract_event_time_and_strip(props, explicit_ts_ms = nil)
      return [{}, explicit_ts_ms] if props.nil? || props.empty?

      stripped = {}
      has_hash_time = false
      hash_time_val = nil
      has_dollar_time = false
      dollar_time_val = nil

      props.each do |k, v|
        trimmed = k.to_s.strip
        case trimmed
        when '#time'
          has_hash_time = true
          hash_time_val = v
        when '$time'
          has_dollar_time = true
          dollar_time_val = v
        else
          stripped[k.to_s] = v
        end
      end

      return [stripped, explicit_ts_ms] if explicit_ts_ms && explicit_ts_ms > 0

      resolved_ms = nil
      resolved_ms = parse_event_time_value('$time', dollar_time_val) if has_dollar_time
      resolved_ms = parse_event_time_value('#time', hash_time_val) if has_hash_time

      [stripped, resolved_ms]
    end

    # 将 `#time` / `$time` 属性值解析为 Unix 毫秒时间戳
    def parse_event_time_value(key, raw)
      case raw
      when Time
        (raw.to_r * 1000).round.to_i
      when DateTime
        (raw.to_time.to_r * 1000).round.to_i
      when Integer
        raise AbiSdkError, "invalid #{key} property: unix timestamp must be positive" if raw <= 0

        raw >= 100_000_000_000 ? raw : raw * 1000
      when Float
        if raw.nan? || raw.infinite? || raw <= 0
          raise AbiSdkError, "invalid #{key} property: non-positive float timestamp"
        end

        raw >= 100_000_000_000.0 ? raw.round.to_i : (raw * 1000).round.to_i
      when String
        s = raw.strip
        raise AbiSdkError, "invalid #{key} property: time string must not be empty" if s.empty?

        unless /\A\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.match?(s)
          raise AbiSdkError, "invalid #{key} property #{raw.inspect}: expected ISO-8601 or 'YYYY-MM-DD HH:MM:SS'"
        end

        begin
          t = Time.iso8601(s)
          (t.to_r * 1000).round.to_i
        rescue ArgumentError
          begin
            t = Time.parse(s)
            (t.to_r * 1000).round.to_i
          rescue ArgumentError => e
            raise AbiSdkError, "invalid #{key} property #{raw.inspect}: #{e.message}"
          end
        end
      else
        raise AbiSdkError, "invalid #{key} property: unsupported value type #{raw.class}"
      end
    end

    def resolve_batch_endpoint(server_url)
      trimmed = server_url.to_s.strip.sub(%r{/+\z}, '')
      raise AbiSdkError, 'server_url must not be empty' if trimmed.empty?

      return trimmed if trimmed.end_with?('/collect/api/v1/track/batch')

      "#{trimmed}/collect/api/v1/track/batch"
    end
  end

  # 表示发送至 ABI 采集网关的单条事件结构（Wire Payload）
  class TrackEvent
    attr_reader :event_id, :event_name, :distinct_id, :login_id, :timestamp, :properties

    def initialize(event_id:, event_name:, distinct_id:, login_id:, timestamp:, properties: {})
      @event_id = event_id
      @event_name = event_name
      @distinct_id = distinct_id
      @login_id = login_id
      @timestamp = timestamp
      @properties = properties || {}
    end

    def to_h
      h = {
        'event_id' => @event_id,
        'event_name' => @event_name,
        'distinct_id' => @distinct_id
      }
      h['login_id'] = @login_id unless @login_id.to_s.empty?
      h['timestamp'] = @timestamp
      h['properties'] = @properties
      h
    end

    def to_json(*args)
      to_h.to_json(*args)
    end
  end

  # 内部通用 HTTP 批量发送器（基于 Net::HTTP 与 Zlib 标准库，支持 Gzip 与 429/5xx 退避重试）
  module HttpBatchSender
    @custom_transport = nil

    class << self
      attr_accessor :custom_transport

      def send_payload(server_url:, payload:, compress_gzip: false, timeout_sec: 10, max_retries: 0)
        endpoint = Validator.resolve_batch_endpoint(server_url)
        json_bytes = JSON.generate(payload)

        body_bytes = json_bytes
        headers = {
          'Content-Type' => 'application/json; charset=utf-8',
          'User-Agent' => SDK_VERSION
        }

        if compress_gzip
          sio = StringIO.new
          sio.set_encoding(Encoding::BINARY)
          gz = Zlib::GzipWriter.new(sio)
          gz.write(json_bytes)
          gz.close
          body_bytes = sio.string
          headers['Content-Encoding'] = 'gzip'
        end

        max_attempts = [1, max_retries.to_i + 1].max
        last_error = nil

        max_attempts.times do |attempt|
          if attempt.positive?
            backoff_sec = [2.0, 0.05 * (1 << (attempt - 1))].min
            sleep(backoff_sec)
          end

          status_code, resp_body, transport_err =
            if @custom_transport
              @custom_transport.call(endpoint, headers, body_bytes, timeout_sec)
            else
              execute_http_post(endpoint, headers, body_bytes, timeout_sec)
            end

          if transport_err
            last_error = AbiSdkError.new("send batch request failed: #{transport_err}")
            next
          end

          if status_code == 429 || status_code >= 500
            last_error = AbiSdkError.new("gateway retryable status #{status_code}: #{resp_body}")
            next
          end

          begin
            decoded = JSON.parse(resp_body.to_s)
          rescue JSON::ParserError
            raise AbiSdkError, "gateway returned non-JSON response (status=#{status_code}): #{resp_body}"
          end

          code = decoded.is_a?(Hash) ? decoded['code'].to_i : 0
          if status_code != 200 || code != 200
            msg = decoded.is_a?(Hash) ? decoded['message'].to_s : 'unknown gateway error'
            raise AbiSdkError, "gateway error (status=#{status_code}, code=#{code}): #{msg}"
          end

          return decoded
        end

        raise(last_error || AbiSdkError.new('send batch request failed'))
      end

      private

      def execute_http_post(endpoint, headers, body_bytes, timeout_sec)
        uri = URI.parse(endpoint)
        http = Net::HTTP.new(uri.host, uri.port)
        http.use_ssl = (uri.scheme == 'https')
        http.open_timeout = timeout_sec
        http.read_timeout = timeout_sec

        req = Net::HTTP::Post.new(uri.request_uri)
        headers.each { |k, v| req[k] = v }
        req.body = body_bytes

        resp = http.request(req)
        [resp.code.to_i, resp.body.to_s, nil]
      rescue StandardError => e
        [0, '', e.message]
      end
    end
  end

  # StagingConsumer 支持「第 1 步：暂存事件并预览完整请求 JSON -> 第 2 步：确认后才真正提交」的内存队列消费者。
  # 在显式调用 `confirm_submit` 或 `submit_to_gateway` 之前，`flush` 与 `close` 均不会触发任何网络发送。
  class StagingConsumer
    attr_reader :project_id, :project_token
    attr_accessor :debug, :dry_run

    def initialize(project_id:, project_token:, dry_run: false, debug: false)
      raise AbiSdkError, 'project_id must be greater than 0' if project_id.to_i <= 0
      raise AbiSdkError, 'project_token must not be empty' if project_token.to_s.strip.empty?

      @project_id = project_id.to_i
      @project_token = project_token.to_s.strip
      @dry_run = !!dry_run
      @debug = !!debug
      @events = []
      @mutex = Mutex.new
    end

    def add(event)
      @mutex.synchronize { @events << event }
    end

    def flush
      # 空操作：确保在显式确认提交前不会静默发送
    end

    def close
      # 空操作：保留已暂存事件供预览与确认提交
    end

    def reset
      @mutex.synchronize { @events.clear }
    end

    def events
      @mutex.synchronize { @events.dup }
    end
    alias getEvents events

    def build_request_payload
      @mutex.synchronize do
        payload = {
          'project_id' => @project_id,
          'project_token' => @project_token
        }
        payload['debug'] = true if @debug
        payload['dry_run'] = true if @dry_run
        payload['events'] = @events.map(&:to_h)
        payload
      end
    end
    alias buildRequestPayload build_request_payload

    # 输出格式化缩进后的 `POST /collect/api/v1/track/batch` 完整请求 JSON 字符串（零网络副作用）
    def preview_request_json
      JSON.pretty_generate(build_request_payload)
    end
    alias previewRequestJson preview_request_json

    # 在确认无误后将当前暂存的所有事件正式投递至目标 Consumer（如 BatchConsumer / LoggerConsumer / DebugConsumer）并执行 flush
    def confirm_submit(target_consumer)
      raise AbiSdkError, 'target_consumer must not be nil' if target_consumer.nil?
      raise AbiSdkError, 'target_consumer must not be the same StagingConsumer' if target_consumer.equal?(self)

      snapshot = events
      snapshot.each { |evt| target_consumer.add(evt) }
      target_consumer.flush
    end
    alias confirmSubmit confirm_submit

    # 在确认无误后直接将暂存的请求报文发送至 ABI 采集网关并返回网关响应信封
    def submit_to_gateway(server_url:, compress_gzip: true, timeout_sec: 10, max_retries: 0)
      payload = build_request_payload
      raise AbiSdkError, 'no staged events to submit' if payload['events'].empty?

      HttpBatchSender.send_payload(
        server_url: server_url,
        payload: payload,
        compress_gzip: compress_gzip,
        timeout_sec: timeout_sec,
        max_retries: max_retries
      )
    end
    alias submitToGateway submit_to_gateway
  end

  # BatchConsumer 内存缓冲批量上报消费者（支持按批量阈值自动刷盘、Gzip 压缩与 429/5xx 指数退避重试）
  class BatchConsumer
    def initialize(
      server_url:,
      project_id:,
      project_token:,
      batch_size: 50,
      max_cache_size: 10_000,
      compress_gzip: true,
      timeout_sec: 10,
      max_retries: 3,
      on_error: nil
    )
      raise AbiSdkError, 'server_url is required' if server_url.to_s.strip.empty?
      raise AbiSdkError, 'project_id and project_token are required' if project_id.to_i <= 0 || project_token.to_s.strip.empty?

      @server_url = server_url.to_s.strip
      @project_id = project_id.to_i
      @project_token = project_token.to_s.strip
      @batch_size = [[batch_size.to_i, 1].max, 500].min
      @max_cache_size = [max_cache_size.to_i, 1].max
      @compress_gzip = !!compress_gzip
      @timeout_sec = timeout_sec.to_f.positive? ? timeout_sec.to_f : 10.0
      @max_retries = [max_retries.to_i, 0].max
      @on_error = on_error
      @buffer = []
      @closed = false
      @mutex = Mutex.new
    end

    def add(event)
      should_flush = false
      @mutex.synchronize do
        raise AbiSdkError, 'batch consumer is closed' if @closed
        raise AbiSdkError, "batch consumer buffer full (max=#{@max_cache_size})" if @buffer.length >= @max_cache_size

        @buffer << event
        should_flush = @buffer.length >= @batch_size
      end
      flush if should_flush
    end

    def flush
      loop do
        batch = nil
        @mutex.synchronize do
          return if @buffer.empty?

          batch = @buffer.shift(@batch_size)
        end

        payload = {
          'project_id' => @project_id,
          'project_token' => @project_token,
          'events' => batch.map(&:to_h)
        }

        begin
          HttpBatchSender.send_payload(
            server_url: @server_url,
            payload: payload,
            compress_gzip: @compress_gzip,
            timeout_sec: @timeout_sec,
            max_retries: @max_retries
          )
        rescue StandardError => e
          @on_error&.call(e, batch)
          raise e
        end
      end
    end

    def close
      @mutex.synchronize do
        return if @closed

        @closed = true
      end
      flush
    end
  end

  # LoggerConsumer 本地磁盘 JSONL 轮转落盘消费者（配合 Filebeat / Vector / LogBus 旁路采集）
  class LoggerConsumer
    ROTATE_DAILY  = 'DAILY'
    ROTATE_HOURLY = 'HOURLY'

    def initialize(
      directory:,
      file_prefix: 'abi.log',
      rotate_mode: ROTATE_DAILY,
      max_file_size_mb: 0,
      now_proc: nil
    )
      raise AbiSdkError, 'directory is required for LoggerConsumer' if directory.to_s.strip.empty?

      @directory = directory.to_s.strip
      @file_prefix = file_prefix.to_s.strip.empty? ? 'abi.log' : file_prefix.to_s.strip
      @rotate_mode = rotate_mode.to_s.upcase == ROTATE_HOURLY ? ROTATE_HOURLY : ROTATE_DAILY
      @max_file_size_mb = [max_file_size_mb.to_i, 0].max
      @now_proc = now_proc || -> { Time.now }
      @current_period = ''
      @current_index = 0
      @current_bytes = 0
      @file = nil
      @closed = false
      @mutex = Mutex.new

      FileUtils.mkdir_p(@directory)
    end

    def add(event)
      line = "#{JSON.generate(event.to_h)}\n"
      @mutex.synchronize do
        raise AbiSdkError, 'logger consumer is closed' if @closed

        ensure_file_locked(line.bytesize)
        written = @file.write(line)
        @current_bytes += written
      end
    end

    def flush
      @mutex.synchronize do
        @file&.flush
      end
    end

    def close
      @mutex.synchronize do
        return if @closed

        @closed = true
        if @file
          @file.flush
          @file.close
          @file = nil
        end
      end
    end

    private

    def ensure_file_locked(incoming_bytes)
      now = @now_proc.call
      period = @rotate_mode == ROTATE_HOURLY ? now.strftime('%Y-%m-%d-%H') : now.strftime('%Y-%m-%d')
      max_bytes = @max_file_size_mb.positive? ? @max_file_size_mb * 1024 * 1024 : 0

      need_rotate = @file.nil? ||
                    @current_period != period ||
                    (max_bytes.positive? && (@current_bytes + incoming_bytes) > max_bytes)
      return unless need_rotate

      if @file
        @file.flush
        @file.close
        @file = nil
      end

      if @current_period != period
        @current_period = period
        @current_index = 0
      else
        @current_index += 1
      end

      file_name =
        if @current_index.positive?
          "#{@file_prefix}.#{@current_period}_#{@current_index}"
        else
          "#{@file_prefix}.#{@current_period}"
        end
      full_path = File.join(@directory, file_name)
      @file = File.open(full_path, 'ab')
      @current_bytes = @file.size
    end
  end

  # DebugConsumer 同步联调消费者（逐条发送并开启 `debug=true` 及可选 `dry_run=true`，遇到 L3/L4 校验错误立即抛出异常）
  class DebugConsumer
    def initialize(server_url:, project_id:, project_token:, dry_run: false, timeout_sec: 10)
      raise AbiSdkError, 'server_url is required' if server_url.to_s.strip.empty?
      raise AbiSdkError, 'project_id and project_token are required' if project_id.to_i <= 0 || project_token.to_s.strip.empty?

      @server_url = server_url.to_s.strip
      @project_id = project_id.to_i
      @project_token = project_token.to_s.strip
      @dry_run = !!dry_run
      @timeout_sec = timeout_sec.to_f.positive? ? timeout_sec.to_f : 10.0
    end

    def add(event)
      payload = {
        'project_id' => @project_id,
        'project_token' => @project_token,
        'debug' => true,
        'dry_run' => @dry_run,
        'events' => [event.to_h]
      }

      resp = HttpBatchSender.send_payload(
        server_url: @server_url,
        payload: payload,
        compress_gzip: false,
        timeout_sec: @timeout_sec,
        max_retries: 0
      )
      data = resp.is_a?(Hash) && resp['data'].is_a?(Hash) ? resp['data'] : {}
      rejected = data['rejected'].to_i
      errors = data['errors'].is_a?(Array) ? data['errors'] : []

      return unless rejected.positive? || !errors.empty?

      reason = errors.first.is_a?(Hash) ? errors.first['reason'].to_s : 'rejected by gateway debug validation'
      raise AbiSdkError, "debug validation failed for event #{event.event_name.inspect}: #{reason}"
    end

    def flush
      # 同步发送无需额外 flush
    end

    def close
      # 无需释放额外资源
    end
  end

  # AbiAnalytics 是并发安全的 ABI Ruby 服务端 SDK 核心客户端（同时提供 snake_case 与 camelCase 方法别名，对标 ThinkingData Ruby SDK）
  class AbiAnalytics
    def initialize(consumer)
      raise AbiSdkError, 'consumer must not be nil' if consumer.nil?

      @consumer = consumer
      @super_props = {}
      @dynamic_super_props = nil
      @super_mutex = Mutex.new
    end

    # 注册全局静态公共属性；自动合并至后续所有非 `$user_*` / `#user_*` 的行为事件中。
    # 合并优先级严格遵循：静态公共属性 < 动态公共属性 < 单次事件属性。
    def set_super_properties(props)
      clean = Validator.sanitize_properties(props)
      @super_mutex.synchronize do
        clean.each { |k, v| @super_props[k] = v }
      end
    end
    alias setSuperProperties set_super_properties

    # 根据属性名移除单个已注册的全局静态公共属性
    def unset_super_property(key)
      trimmed = key.to_s.strip
      @super_mutex.synchronize do
        @super_props.delete(key.to_s)
        @super_props.delete(trimmed)
      end
    end
    alias unsetSuperProperty unset_super_property

    # 清空所有已注册的全局静态公共属性
    def clear_super_properties
      @super_mutex.synchronize { @super_props.clear }
    end
    alias clearSuperProperties clear_super_properties

    # 返回当前已注册全局静态公共属性的浅拷贝副本
    def get_super_properties
      @super_mutex.synchronize { @super_props.dup }
    end
    alias getSuperProperties get_super_properties

    # 注册动态公共属性回调（支持传入 Proc/Lambda 或块 block；传 nil 移除回调）
    def set_dynamic_super_properties(callable = nil, &block)
      @super_mutex.synchronize do
        @dynamic_super_props = callable || block
      end
    end
    alias setDynamicSuperProperties set_dynamic_super_properties

    # 上报一条标准用户行为事件（account_id 与 distinct_id 至少一个非空）
    def track(account_id, distinct_id, event_name, properties = {})
      track_with_options(
        account_id: account_id,
        distinct_id: distinct_id,
        event_name: event_name,
        properties: properties
      )
    end

    # 保留方法签名，但在当前版本显式抛出 `AbiSdkError` 且绝不入队伪造的普通 `track` 事件（D7① / G6 门禁）
    # @deprecated [当前版本未开放 / Unsupported in current version] 严守 D7① / G6 门禁，当前版本 dwd_events 存储模型尚未开放首次去重支持；如需同日重试幂等请调用 `track_with_options(event_id: ...)`。
    def track_first(_account_id, _distinct_id, _event_name, _first_check_id, _properties = {})
      raise AbiSdkError, 'track_first is unsupported in current version (D7① / G6 gate); use track_with_options(event_id: ...) for same-day idempotency'
    end
    alias trackFirst track_first

    # 保留方法签名，但在当前版本显式抛出 `AbiSdkError` 且绝不入队伪造的普通 `track` 事件（D7① / G6 门禁）
    # @deprecated [当前版本未开放 / Unsupported in current version] 严守 D7① / G6 门禁，当前版本 dwd_events 存储模型尚未开放局部更新支持。
    def track_update(_account_id, _distinct_id, _event_name, _event_id, _properties = {})
      raise AbiSdkError, 'track_update is unsupported in current version (D7① / G6 gate); use track_with_options(event_id: ...) for same-day idempotency'
    end
    alias trackUpdate track_update

    # 保留方法签名，但在当前版本显式抛出 `AbiSdkError` 且绝不入队伪造的普通 `track` 事件（D7① / G6 门禁）
    # @deprecated [当前版本未开放 / Unsupported in current version] 严守 D7① / G6 门禁，当前版本 dwd_events 存储模型尚未开放跨分区整行覆盖重写支持。
    def track_overwrite(_account_id, _distinct_id, _event_name, _event_id, _properties = {})
      raise AbiSdkError, 'track_overwrite is unsupported in current version (D7① / G6 gate); use track_with_options(event_id: ...) for same-day idempotency'
    end
    alias trackOverwrite track_overwrite

    # 覆盖设置用户画像属性（`$user_set`）
    def user_set(account_id, distinct_id, properties)
      send_user_event(account_id, distinct_id, '$user_set', properties)
    end
    alias userSet user_set

    # 仅当用户画像属性尚未设置时首次写入（`$user_set_once`）
    def user_set_once(account_id, distinct_id, properties)
      send_user_event(account_id, distinct_id, '$user_set_once', properties)
    end
    alias userSetOnce user_set_once

    # 对数值型用户画像属性执行原子增量累加（`$user_add`）
    def user_add(account_id, distinct_id, properties)
      raise AbiSdkError, 'properties must be a Hash' unless properties.is_a?(Hash)

      properties.each do |k, v|
        trimmed = k.to_s.strip
        next if ['#time', '$time'].include?(trimmed)

        unless v.is_a?(Integer) || v.is_a?(Float)
          raise AbiSdkError, "user_add property #{k.inspect} must be numeric, got #{v.class}"
        end
      end
      send_user_event(account_id, distinct_id, '$user_add', properties)
    end
    alias userAdd user_add

    # 向列表型（Array）用户画像属性末尾追加元素（`$user_append`，不去重）
    def user_append(account_id, distinct_id, properties)
      raise AbiSdkError, 'properties must be a Hash' unless properties.is_a?(Hash)

      properties.each do |k, v|
        trimmed = k.to_s.strip
        next if ['#time', '$time'].include?(trimmed)
        raise AbiSdkError, "user_append property #{k.inspect} must be an Array" unless v.is_a?(Array)
      end
      send_user_event(account_id, distinct_id, '$user_append', properties)
    end
    alias userAppend user_append

    # 向列表型（Array）用户画像属性追加元素并自动集合去重（`$user_uniq_append`）
    def user_uniq_append(account_id, distinct_id, properties)
      raise AbiSdkError, 'properties must be a Hash' unless properties.is_a?(Hash)

      properties.each do |k, v|
        trimmed = k.to_s.strip
        next if ['#time', '$time'].include?(trimmed)
        raise AbiSdkError, "user_uniq_append property #{k.inspect} must be an Array" unless v.is_a?(Array)
      end
      send_user_event(account_id, distinct_id, '$user_uniq_append', properties)
    end
    alias userUniqAppend user_uniq_append

    # 清空并重置指定的用户画像属性键（`$user_unset`）
    def user_unset(account_id, distinct_id, *keys)
      props = {}
      keys.flatten.each do |k|
        props[k.to_s] = 0
      end
      send_user_event(account_id, distinct_id, '$user_unset', props)
    end
    alias userUnset user_unset

    # 删除指定用户的画像记录（`$user_del`）
    def user_delete(account_id, distinct_id)
      send_user_event(account_id, distinct_id, '$user_del', {})
    end
    alias userDelete user_delete

    # 支持完整自定义选项的事件上报（支持指定确定性幂等 `event_id`、`account_id` / `distinct_id` 及 `timestamp`）
    def track_with_options(options)
      evt = build_event(options, true)
      @consumer.add(evt)
    end
    alias trackWithOptions track_with_options

    def flush
      @consumer.flush
    end

    def close
      @consumer.close
    end

    private

    def send_user_event(account_id, distinct_id, op_event_name, properties)
      evt = build_event({
        event_name: op_event_name,
        account_id: account_id,
        distinct_id: distinct_id,
        properties: properties || {}
      }, false)
      @consumer.add(evt)
    end

    def fetch_opt(opts, sym_key)
      opts[sym_key] || opts[sym_key.to_s]
    end

    def build_event(opts, include_super_props)
      raw_event_name = fetch_opt(opts, :event_name).to_s
      event_name = Validator.validate_event_name(raw_event_name)

      raw_distinct = (fetch_opt(opts, :distinct_id) || '').to_s
      raw_account = (fetch_opt(opts, :account_id) || fetch_opt(opts, :login_id) || '').to_s

      norm_distinct = Validator.normalize_identity(raw_distinct, MAX_DISTINCT_ID_BYTES)
      norm_login = Validator.normalize_identity(raw_account, MAX_LOGIN_ID_BYTES)

      # 对标数数科技 ThinkingData：distinct_id (<=64B) 与 login_id (<=128B) 至少一个非空，绝不将 login_id 回填到 distinct_id
      if norm_distinct.empty? && norm_login.empty?
        raise AbiSdkError, 'at least one of account_id (login_id) or distinct_id is required'
      end

      raw_event_id = (fetch_opt(opts, :event_id) || '').to_s
      event_id = raw_event_id.empty? ? '' : Validator.normalize_identity(raw_event_id, MAX_EVENT_ID_BYTES)
      event_id = SecureRandom.uuid if event_id.empty?

      explicit_ts_ms = nil
      ts_opt = fetch_opt(opts, :timestamp)
      if ts_opt.is_a?(Time)
        explicit_ts_ms = (ts_opt.to_r * 1000).round.to_i
      elsif ts_opt.is_a?(DateTime)
        explicit_ts_ms = (ts_opt.to_time.to_r * 1000).round.to_i
      elsif ts_opt.is_a?(Integer) && ts_opt.positive?
        explicit_ts_ms = ts_opt >= 100_000_000_000 ? ts_opt : ts_opt * 1000
      end

      raw_props = fetch_opt(opts, :properties) || {}
      props_without_time, resolved_ts_ms = Validator.extract_event_time_and_strip(raw_props, explicit_ts_ms)
      clean_props = Validator.sanitize_properties(props_without_time)

      final_props = {}
      is_user_event = event_name.start_with?('$user_') || event_name.start_with?('#user_')

      if include_super_props && !is_user_event
        dynamic_fn = nil
        @super_mutex.synchronize do
          @super_props.each { |k, v| final_props[k] = v }
          dynamic_fn = @dynamic_super_props
        end

        if dynamic_fn
          dyn_raw = dynamic_fn.call
          if dyn_raw.is_a?(Hash)
            clean_dyn = Validator.sanitize_properties(dyn_raw)
            clean_dyn.each { |k, v| final_props[k] = v }
          end
        end
      end

      clean_props.each { |k, v| final_props[k] = v }

      timestamp_ms = resolved_ts_ms || (Time.now.to_r * 1000).round.to_i

      TrackEvent.new(
        event_id: event_id,
        event_name: event_name,
        distinct_id: norm_distinct,
        login_id: norm_login,
        timestamp: timestamp_ms,
        properties: final_props
      )
    end
  end
end
