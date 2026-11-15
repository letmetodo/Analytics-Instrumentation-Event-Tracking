// ABI Flutter / Dart 数据采集分析 SDK（严格对齐 ThinkingData 数数科技规范）
library abi_sdk;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// 初始化 [AbiAnalytics] 客户端所需的连接与批量上报配置项。
///
/// ### 配置示例
/// ```dart
/// final config = AbiConfig(
///   serverUrl: 'http://localhost:8081',
///   projectId: 1,
///   projectToken: 'abi_tok_demo_project_1',
///   appVersion: '2.1.0',
///   batchSize: 20,
///   flushInterval: Duration(seconds: 5),
///   debug: true,
///   dryRun: true, // 开启演练校验模式，仅校验报文格式而不落库
/// );
/// AbiAnalytics.instance.init(config);
/// ```
class AbiConfig {
  /// 采集网关基础地址（例如 `http://localhost:8081` 或 Android 模拟器 `http://10.0.2.2:8081`）。
  final String serverUrl;

  /// ABI 归属项目 ID。
  final int projectId;

  /// 项目接入令牌（Project Token）。
  final String projectToken;

  /// 宿主应用版本号，自动注入事件预置属性 `$app_version`。
  final String appVersion;

  /// 单次批量上报触发阈值（条数）。
  final int batchSize;

  /// 后台定时刷新队列的时间间隔。
  final Duration flushInterval;

  /// 是否开启调试即时上报模式。
  final bool debug;

  /// 是否开启网关 `dry_run` 演练校验模式（仅校验不写入 Kafka/StarRocks）。
  final bool dryRun;

  /// 是否启用后台定时自动刷新与 `batchSize` 自动上报（默认 `true`；交互式预览演练可设为 `false`，由用户手动确认提交）。
  final bool autoFlush;

  /// 可选本地持久化读取回调（用于持久化 `distinct_id` 与 `login_id` 存储键）。
  final String? Function(String key)? storageRead;

  /// 可选本地持久化写入/删除回调（`value == null` 时删除对应存储键）。
  final void Function(String key, String? value)? storageWrite;

  const AbiConfig({
    required this.serverUrl,
    required this.projectId,
    required this.projectToken,
    this.appVersion = '1.0.0',
    this.batchSize = 20,
    this.flushInterval = const Duration(seconds: 5),
    this.debug = false,
    this.dryRun = false,
    this.autoFlush = true,
    this.storageRead,
    this.storageWrite,
  });
}

/// ABI 用户行为分析（UBA）与 BI 平台 Flutter 单例采集客户端。
///
/// 严格对齐 ThinkingData 数数科技规范的双标识身份体系（`distinct_id` 访客/设备 ID 与 `login_id` 登录账号 ID，
/// 通过 `identify`、`login`、`logout` 纯本地状态切换并持久化）、静态与动态公共属性、
/// 高精度秒表计时事件（`timeEvent`）、同日固定 `eventId` 幂等重放以及全套用户画像操作（`$user_*`）。
///
/// ### 快速上手示例
/// ```dart
/// final sdk = AbiAnalytics.instance;
/// sdk.init(const AbiConfig(
///   serverUrl: 'http://localhost:8081',
///   projectId: 1,
///   projectToken: 'abi_tok_demo',
///   appVersion: '1.2.0',
///   dryRun: true,
/// ));
///
/// // 1. 访客标识设置、公共属性注册与登录账号设置（纯本地状态切换，不触发网络事件）
/// sdk.identify('flutter_visitor_device_001');
/// sdk.setSuperProperties({'channel': 'AppStore', 'env': 'prod'});
/// sdk.login('acct_flutter_10001');
///
/// // 2. 事件秒表计时与同日固定 eventId 幂等上报
/// sdk.timeEvent('OrderPaid');
/// sdk.track('OrderPaid', eventId: 'evt_ord_20261110_01', properties: {
///   'order_id': 'ord_20261110_01',
///   'amount': 299.0,
/// });
///
/// // 3. 用户画像变更与手动立即上报
/// sdk.userSet({'vip_level': 'Gold', 'city': 'Shanghai'});
/// sdk.userAdd({'points': 100});
/// await sdk.flush();
/// ```
class AbiAnalytics {
  /// 全局单例实例。
  static final AbiAnalytics instance = AbiAnalytics._internal();
  AbiAnalytics._internal();

  static const int maxDistinctIdBytes = 64;
  static const int maxLoginIdBytes = 128;
  static const int maxEventNameChars = 128;
  static const int maxPropKeyChars = 64;
  static const int maxSafeInteger = 9007199254740991;
  static final RegExp _identifierPattern = RegExp(r'^[A-Za-z_][A-Za-z0-9_]*$');
  static const Set<String> _systemEvents = {
    '\$signup', '\$login', '\$pageview',
    '\$AppStart', '\$AppEnd', '\$AppClick', '\$AppViewScreen',
    '\$user_set', '#user_set',
    '\$user_set_once', '#user_set_once',
    '\$user_add', '#user_add',
    '\$user_unset', '#user_unset',
    '\$user_append', '#user_append',
    '\$user_uniq_append', '#user_uniq_append',
    '\$user_del', '#user_del',
  };
  static const Set<String> _systemProps = {
    '\$os', '#os', 'os',
    '\$os_version', '#os_version', 'os_version',
    '\$app_version', '#app_version', 'app_version',
    '\$browser', '#browser', 'browser',
    '\$browser_version', '#browser_version', 'browser_version',
    '\$city', '#city', 'city',
    '\$province', '#province', 'province',
    '\$country', '#country', 'country',
    '\$country_code', '#country_code', 'country_code',
    '\$ip', '#ip', 'ip',
    '\$network', '#network', 'network',
    '\$network_type', '#network_type', 'network_type',
    '\$platform', '#platform', 'platform',
    '\$device_id', '#device_id', 'device_id',
    '\$session_id', '#session_id', 'session_id',
    '\$screen_width', '#screen_width', 'screen_width',
    '\$screen_height', '#screen_height', 'screen_height',
    '\$model', '#model', 'model',
    '\$device_model', '#device_model', 'device_model',
    '\$manufacturer', '#manufacturer', 'manufacturer',
    '\$carrier', '#carrier', 'carrier',
    '\$url', '#url', 'url',
    '\$url_path', '#url_path', 'url_path',
    '\$referrer', '#referrer', 'referrer',
    '\$title', '#title', 'title',
    '\$duration', '#duration', 'duration',
    '\$lib', '#lib', 'lib',
    '\$lib_version', '#lib_version', 'lib_version',
    '\$zone_offset', '#zone_offset', 'zone_offset',
    '\$first_check_id', '#first_check_id', 'first_check_id',
  };

  late AbiConfig _config;
  bool _initialized = false;
  String _distinctId = _generateUuidV4();
  String _loginId = '';

  String get _distinctIdStorageKey =>
      _initialized ? 'abi_sdk_${_config.projectId}_distinct_id' : 'distinct_id';
  String get _loginIdStorageKey =>
      _initialized ? 'abi_sdk_${_config.projectId}_login_id' : 'login_id';

  /// 当前访客/设备标识 `distinct_id`（初始化自动生成 UUIDv4，仅通过 [identify] 更新，不受 [login] 覆盖）。
  String get distinctId => _distinctId;

  /// 当前已设置的实名登录账号标识 `login_id`（未登录时为空字符串）。
  String get loginId => _loginId;

  /// 内存缓冲队列中尚未上报的事件条数。
  int get pendingQueueLength => _queue.length;

  /// 最近一次调用 [flush] 时的网关 HTTP 状态码（网络不可达时为 `0`，尚未发送时为 `null`）。
  int? get lastStatusCode => _lastStatusCode;

  /// 最近一次调用 [flush] 时的网关原始响应体或异常说明。
  String get lastResponseBody => _lastResponseBody;

  final Map<String, dynamic> _superProperties = {};
  Map<String, dynamic> Function()? _dynamicSuperProps;
  final Map<String, Stopwatch> _timers = {};
  final List<Map<String, dynamic>> _queue = [];
  Timer? _flushTimer;
  bool _flushing = false;
  int? _lastStatusCode;
  String _lastResponseBody = '';

  /// 使用 [AbiConfig] 初始化 SDK 单例；当 [AbiConfig.autoFlush] 为 `true` 时启动后台周期性批量上报定时器。
  ///
  /// ```dart
  /// AbiAnalytics.instance.init(const AbiConfig(
  ///   serverUrl: 'http://localhost:8081',
  ///   projectId: 1,
  ///   projectToken: 'abi_tok_demo',
  ///   dryRun: true,
  ///   autoFlush: false, // 预览确认模式下禁用自动上报
  /// ));
  /// ```
  void init(AbiConfig config) {
    _config = config;
    _initialized = true;
    final savedDistinct = config.storageRead?.call(_distinctIdStorageKey);
    if (savedDistinct != null && savedDistinct.trim().isNotEmpty) {
      try {
        _distinctId = _normalizeIdentity(savedDistinct, maxDistinctIdBytes, 'distinct_id');
      } catch (_) {
        _distinctId = _generateUuidV4();
        config.storageWrite?.call(_distinctIdStorageKey, _distinctId);
      }
    } else {
      if (_distinctId.isEmpty) {
        _distinctId = _generateUuidV4();
      }
      config.storageWrite?.call(_distinctIdStorageKey, _distinctId);
    }

    final savedLogin = config.storageRead?.call(_loginIdStorageKey);
    if (savedLogin != null && savedLogin.trim().isNotEmpty) {
      try {
        _loginId = _normalizeIdentity(savedLogin, maxLoginIdBytes, 'login_id');
      } catch (_) {
        _loginId = '';
      }
    } else if (config.storageRead != null) {
      _loginId = '';
    }

    _flushTimer?.cancel();
    _flushTimer = config.autoFlush
        ? Timer.periodic(config.flushInterval, (_) => flush())
        : null;
  }

  /// 清空内存缓冲队列中尚未上报的所有待发送事件。
  void clearPendingQueue() {
    _queue.clear();
  }

  /// 构造当前待提交给 `POST /collect/api/v1/track/batch` 的完整请求体快照。
  ///
  /// 返回结构：`{ project_id, project_token, debug?, dry_run?, events: List.from(_queue) }`。
  Map<String, dynamic> buildPendingBatchPayload() {
    if (!_initialized) {
      return <String, dynamic>{
        'project_id': 0,
        'project_token': '',
        'events': <Map<String, dynamic>>[],
      };
    }
    return <String, dynamic>{
      'project_id': _config.projectId,
      'project_token': _config.projectToken,
      if (_config.debug) 'debug': true,
      if (_config.dryRun) 'dry_run': true,
      'events': List<Map<String, dynamic>>.from(
        _queue.map((evt) => Map<String, dynamic>.from(evt)),
      ),
    };
  }

  /// 自定义设置访客/设备标识 `distinct_id`（UTF-8 编码不超过 64 字节，持久化至本地 `distinct_id` 存储键，不发送网络事件）。
  ///
  /// ```dart
  /// AbiAnalytics.instance.identify('visitor_flutter_device_01');
  /// ```
  void identify(String distinctId) {
    final norm = _normalizeIdentity(distinctId, maxDistinctIdBytes, 'distinct_id');
    _distinctId = norm;
    if (_initialized) {
      _config.storageWrite?.call(_distinctIdStorageKey, norm);
    }
  }

  /// 设置实名登录账号标识 `login_id`（UTF-8 编码不超过 128 字节，持久化至本地存储；绝不覆盖 `distinctId`，且不自动触发任何网络事件）。
  ///
  /// ```dart
  /// AbiAnalytics.instance.login('user_flutter_10001');
  /// ```
  void login(String accountId) {
    final normLogin = _normalizeIdentity(accountId, maxLoginIdBytes, 'login_id');
    _loginId = normLogin;
    if (_initialized) {
      _config.storageWrite?.call(_loginIdStorageKey, normLogin);
    }
  }

  /// 退出登录，清空当前 `loginId` 并保持访客标识 `distinctId` 不变（不发送网络事件）。
  ///
  /// ```dart
  /// AbiAnalytics.instance.logout();
  /// ```
  void logout() {
    _loginId = '';
    if (_initialized) {
      _config.storageWrite?.call(_loginIdStorageKey, null);
    }
  }

  /// 注册静态公共属性，后续所有非 `$user_*` 画像事件均会自动合并这些属性。
  ///
  /// ```dart
  /// AbiAnalytics.instance.setSuperProperties({
  ///   'channel': 'flutter_ios',
  ///   'ab_group': 'checkout_v2',
  /// });
  /// ```
  void setSuperProperties(Map<String, dynamic> props) {
    _superProperties.addAll(_sanitizeProperties(props));
  }

  /// 按属性名移除单个已注册的静态公共属性。
  ///
  /// ```dart
  /// AbiAnalytics.instance.unsetSuperProperty('ab_group');
  /// ```
  void unsetSuperProperty(String key) {
    final trimmed = key.trim();
    if (trimmed.isEmpty) return;
    _superProperties.remove(trimmed);
  }

  /// 清空所有已注册的静态公共属性。
  ///
  /// ```dart
  /// AbiAnalytics.instance.clearSuperProperties();
  /// ```
  void clearSuperProperties() {
    _superProperties.clear();
  }

  /// 获取当前已注册静态公共属性的浅拷贝快照。
  ///
  /// ```dart
  /// final currentProps = AbiAnalytics.instance.getSuperProperties();
  /// ```
  Map<String, dynamic> getSuperProperties() => Map<String, dynamic>.from(_superProperties);

  /// 注册动态公共属性回调函数，每次调用 [track] 时实时求值并附加到非 `$user_*` 事件中（优先级低于单次事件 `properties`）。
  ///
  /// ```dart
  /// AbiAnalytics.instance.setDynamicSuperProperties(() => {
  ///   'network_state': 'wifi',
  /// });
  /// ```
  void setDynamicSuperProperties(Map<String, dynamic> Function()? fn) {
    _dynamicSuperProps = fn;
  }

  /// 为指定 [eventName] 启动高精度秒表计时；下一次上报同名 [track] 事件时会自动计算并附加秒级 `$duration` 属性。
  ///
  /// ```dart
  /// AbiAnalytics.instance.timeEvent('OrderPaid');
  /// // ... 用户完成收银台支付流程 ...
  /// AbiAnalytics.instance.track('OrderPaid', properties: {'amount': 199.0});
  /// ```
  void timeEvent(String eventName) {
    _timersStart(eventName);
  }

  void _timersStart(String eventName) {
    _timers[eventName] = Stopwatch()..start();
  }

  /// 采集并入队一条自定义业务事件或系统事件，返回归一化后的幂等 `event_id`。
  ///
  /// 支持通过可选参数 [timestamp] 指定事件发生时间；若 [properties] 中包含 `'#time'` 或 `'$time'`
  /// （支持 `DateTime`、`int` 时间戳或 ISO 字符串），会自动提取为毫秒 `timestamp` 并从上报属性中剥离。
  /// 对于绝对值超过 `9007199254740991`（$2^{53}-1$）的大整数属性，会自动转为字符串以保护精度。
  ///
  /// ```dart
  /// final eventId = AbiAnalytics.instance.track(
  ///   'OrderPaid',
  ///   properties: {
  ///     'order_id': 'ord_9001',
  ///     'amount': 199.95,
  ///     'snowflake_seq': 9007199254740993, // 自动序列化为字符串避免精度丢失
  ///   },
  /// );
  /// ```
  String track(
    String eventName, {
    Map<String, dynamic>? properties,
    String? eventId,
    DateTime? timestamp,
  }) {
    if (!_initialized) {
      throw StateError('AbiAnalytics.init must be called before track');
    }
    final normEvent = _validateEventName(eventName);
    if (timestamp != null && timestamp.millisecondsSinceEpoch <= 0) {
      throw ArgumentError('timestamp must be positive');
    }

    int? extractedTimeMs;
    Map<String, dynamic>? sanitizedCustomProps;
    if (properties != null) {
      final filteredProps = <String, dynamic>{};
      dynamic rawTimeVal;
      String? rawTimeKey;
      var hasHashTime = false;
      properties.forEach((rawKey, value) {
        final trimmedKey = rawKey.trim();
        if (trimmedKey == '#time') {
          hasHashTime = true;
          rawTimeKey = '#time';
          rawTimeVal = value;
        } else if (trimmedKey == '\$time') {
          if (!hasHashTime) {
            rawTimeKey = '\$time';
            rawTimeVal = value;
          }
        } else {
          filteredProps[rawKey] = value;
        }
      });
      if (rawTimeKey != null && rawTimeVal != null) {
        extractedTimeMs = _parseTimePropertyMs(rawTimeKey!, rawTimeVal);
      }
      sanitizedCustomProps = _sanitizeProperties(filteredProps);
    }

    final resolvedEventId = (eventId != null && eventId.isNotEmpty)
        ? _normalizeIdentity(eventId, 64, 'event_id')
        : _generateUuidV4();

    final isUserEvent = normEvent.startsWith('\$user_') || normEvent.startsWith('#user_');
    final merged = isUserEvent
        ? <String, dynamic>{}
        : <String, dynamic>{
            '\$lib': 'abi-flutter-sdk',
            '\$lib_version': '1.0.0',
            '\$os': Platform.operatingSystem,
            '\$os_version': Platform.operatingSystemVersion,
            '\$app_version': _config.appVersion,
            ..._superProperties,
          };
    if (!isUserEvent && _dynamicSuperProps != null) {
      final dynRaw = _dynamicSuperProps!();
      final dynFiltered = <String, dynamic>{};
      dynRaw.forEach((k, v) {
        final trimmed = k.trim();
        if (trimmed != '#time' && trimmed != '\$time') {
          dynFiltered[k] = v;
        }
      });
      merged.addAll(_sanitizeProperties(dynFiltered));
    }
    final sw = _timers.remove(normEvent);
    if (sw != null) {
      sw.stop();
      merged['\$duration'] = double.parse((sw.elapsedMilliseconds / 1000.0).toStringAsFixed(3));
    }
    if (sanitizedCustomProps != null) {
      merged.addAll(sanitizedCustomProps);
    }

    final resolvedTimestampMs = timestamp != null
        ? timestamp.millisecondsSinceEpoch
        : (extractedTimeMs ?? DateTime.now().millisecondsSinceEpoch);

    _queue.add({
      'event_id': resolvedEventId,
      'event_name': normEvent,
      'distinct_id': _distinctId,
      if (_loginId.isNotEmpty) 'login_id': _loginId,
      'timestamp': resolvedTimestampMs,
      'properties': merged,
    });

    if (_config.autoFlush && (_queue.length >= _config.batchSize || _config.debug)) {
      unawaited(flush());
    }
    return resolvedEventId;
  }

  /// 可修改事件局部更新接口（当前版本未开放）。
  ///
  /// **[当前版本未开放 / Unsupported in current version]** 详见 RESTFUL_API.md §3.3 (D7① / G6 gate)。
  /// 调用此方法将直接抛出 [UnsupportedError]，绝不静默入队普通 `track` 事件。
  @Deprecated('当前版本未开放 (RESTFUL_API.md §3.3 D7① / G6 gate)，调用将抛出 UnsupportedError')
  String trackUpdate(String eventName, String eventId, Map<String, dynamic> properties) {
    throw UnsupportedError(
      'trackUpdate is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); emit distinct milestone events via track(...) instead',
    );
  }

  /// 可修改事件全量覆盖重写接口（当前版本未开放）。
  ///
  /// **[当前版本未开放 / Unsupported in current version]** 详见 RESTFUL_API.md §3.3 (D7① / G6 gate)。
  /// 调用此方法将直接抛出 [UnsupportedError]，绝不静默入队普通 `track` 事件。
  @Deprecated('当前版本未开放 (RESTFUL_API.md §3.3 D7① / G6 gate)，调用将抛出 UnsupportedError')
  String trackOverwrite(String eventName, String eventId, Map<String, dynamic> properties) {
    throw UnsupportedError(
      'trackOverwrite is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); emit distinct milestone events via track(...) instead',
    );
  }

  /// 覆盖设置用户画像属性（上报 `$user_set`，已存在的同名属性会被新值覆盖）。
  ///
  /// ```dart
  /// AbiAnalytics.instance.userSet({'vip_tier': 'Platinum', 'city': 'Hangzhou'});
  /// ```
  String userSet(Map<String, dynamic> properties) => track('\$user_set', properties: properties);

  /// 首次设置用户画像属性（上报 `$user_set_once`，仅当该属性为空或未设置时生效）。
  ///
  /// ```dart
  /// AbiAnalytics.instance.userSetOnce({'first_install_channel': 'organic'});
  /// ```
  String userSetOnce(Map<String, dynamic> properties) => track('\$user_set_once', properties: properties);

  /// 对数值型用户画像属性执行原子累加（上报 `$user_add`，传入负数表示扣减）。
  ///
  /// ```dart
  /// AbiAnalytics.instance.userAdd({'loyalty_points': 100, 'order_count': 1});
  /// ```
  String userAdd(Map<String, num> properties) => track('\$user_add', properties: properties);

  /// 清空指定的用户画像属性键列表（上报 `$user_unset`）。
  ///
  /// ```dart
  /// AbiAnalytics.instance.userUnset(['temp_coupon_code', 'trial_badge']);
  /// ```
  String userUnset(List<String> keys) =>
      track('\$user_unset', properties: {for (final k in keys) k: 0});

  /// 向列表类型的用户画像属性追加元素（上报 `$user_append`，不去重）。
  ///
  /// ```dart
  /// AbiAnalytics.instance.userAppend({'favorite_categories': ['electronics', 'gaming']});
  /// ```
  String userAppend(Map<String, List<dynamic>> properties) =>
      track('\$user_append', properties: properties);

  /// 向列表类型的用户画像属性去重追加元素（上报 `$user_uniq_append`）。
  ///
  /// ```dart
  /// AbiAnalytics.instance.userUniqAppend({'badges': ['early_adopter', 'vip']});
  /// ```
  String userUniqAppend(Map<String, List<dynamic>> properties) =>
      track('\$user_uniq_append', properties: properties);

  /// 标记删除当前用户的画像记录（上报 `$user_del`）。
  ///
  /// ```dart
  /// AbiAnalytics.instance.userDelete();
  /// ```
  String userDelete() => track('\$user_del');

  /// 两步式无界面演练（第 1 步）：以 `autoFlush: false` 构建全套埋点场景参数（身份、静态/动态公共属性、
  /// 秒表计时事件、`> 2^53 - 1` 大整数、独立里程碑事件与 `$user_*` 画像操作），并返回待提交给
  /// `POST /collect/api/v1/track/batch` 的格式化具体请求 JSON 字符串（绝不自动发送、不追加历史日志）。
  ///
  /// ```dart
  /// final requestJson = AbiAnalytics.instance.previewScenarioPayload(dryRun: true);
  /// print(requestJson);
  /// final ok = await AbiAnalytics.instance.confirmSubmit();
  /// ```
  String previewScenarioPayload({
    String serverUrl = 'http://localhost:8081',
    int projectId = 1,
    String projectToken = 'abi_tok_demo_flutter',
    bool dryRun = true,
  }) {
    init(AbiConfig(
      serverUrl: serverUrl,
      projectId: projectId,
      projectToken: projectToken,
      appVersion: '1.0.0-demo',
      dryRun: dryRun,
      autoFlush: false,
    ));
    clearPendingQueue();
    clearSuperProperties();
    logout();

    identify('visitor_flutter_demo_001');
    login('user_flutter_8888');
    setSuperProperties({'channel': 'flutter_demo', 'sdk_env': 'sandbox'});
    setDynamicSuperProperties(() => {'dyn_sequence': 1});

    timeEvent('OrderPaid');
    track(
      'OrderPaid',
      properties: {
        'order_id': 'ord_fl_1001',
        'amount': 259.90,
        'currency': 'CNY',
        'snowflake_seq': 9007199254740993,
      },
      eventId: 'evt_flutter_order_1001',
    );
    track(
      'OrderSettled',
      properties: {
        'order_id': 'ord_fl_1001',
        'order_status': 'settled',
        'amount': 239.90,
        'discount_applied': true,
      },
      eventId: 'evt_flutter_order_settled_1001',
    );

    userSet({'vip_level': 'Diamond', 'city': 'Shenzhen'});
    userSetOnce({'first_source': 'AppStore_Search'});
    userAdd({'loyalty_points': 100});
    userAppend({
      'interests': ['analytics', 'flutter'],
    });
    userUniqAppend({
      'interests': ['flutter', 'starrocks'],
    });
    userUnset(['temp_campaign_tag']);
    userDelete();

    return const JsonEncoder.withIndent('  ').convert(buildPendingBatchPayload());
  }

  /// 两步式无界面演练（第 2 步）：确认提交当前待发送队列，并返回单次发送结果摘要。
  Future<bool> confirmSubmit() => flush();

  /// 立即将内存队列中的所有待发事件分批发送至采集网关 `/collect/api/v1/track/batch`。
  Future<bool> flush() async {
    if (!_initialized || _flushing || _queue.isEmpty) return true;
    _flushing = true;
    try {
      while (_queue.isNotEmpty) {
        final count = min(_config.batchSize, _queue.length);
        final batch = _queue.sublist(0, count);
        final payload = <String, dynamic>{
          'project_id': _config.projectId,
          'project_token': _config.projectToken,
          'events': batch,
          if (_config.debug) 'debug': true,
          if (_config.dryRun) 'dry_run': true,
        };
        final baseUrl = _config.serverUrl.replaceAll(RegExp(r'/+$'), '');
        final endpoint = baseUrl.endsWith('/collect/api/v1/track/batch')
            ? baseUrl
            : '$baseUrl/collect/api/v1/track/batch';
        final uri = Uri.parse(endpoint);
        final status = await _postJson(uri, payload);
        if (status >= 200 && status < 300) {
          _queue.removeRange(0, count);
          continue;
        }
        if (status == 429 || status >= 500 || status == 0) {
          // 网络断连、429 限流或 5xx 异常时保留原队列与 event_id，等待下次幂等重试
          return false;
        }
        _queue.removeRange(0, count);
        return false;
      }
      return true;
    } finally {
      _flushing = false;
    }
  }

  Future<int> _postJson(Uri uri, Map<String, dynamic> body) async {
    final client = HttpClient();
    try {
      final req = await client.postUrl(uri);
      req.headers.set('Content-Type', 'application/json');
      req.add(utf8.encode(jsonEncode(body)));
      final res = await req.close();
      final text = await utf8.decoder.bind(res).join();
      _lastStatusCode = res.statusCode;
      _lastResponseBody = text;
      return res.statusCode;
    } catch (e) {
      _lastStatusCode = 0;
      _lastResponseBody = e.toString();
      return 0;
    } finally {
      client.close(force: false);
    }
  }

  static String _normalizeIdentity(String val, int maxBytes, String field) {
    for (final unit in val.codeUnits) {
      if ((unit < 0x20 && (unit < 0x09 || unit > 0x0d)) || unit == 0x7f) {
        throw ArgumentError('$field contains control character');
      }
    }
    final trimmed = val.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError('$field cannot be empty');
    }
    final bytes = utf8.encode(trimmed);
    if (bytes.length > maxBytes) {
      throw ArgumentError('$field exceeds $maxBytes UTF-8 bytes');
    }
    return trimmed;
  }

  static String _validateEventName(String eventName) {
    final trimmed = eventName.trim();
    if (trimmed.isEmpty || trimmed.length > maxEventNameChars) {
      throw ArgumentError('invalid event_name "$trimmed"');
    }
    if (_systemEvents.contains(trimmed) || _identifierPattern.hasMatch(trimmed)) {
      return trimmed;
    }
    throw ArgumentError('invalid event_name "$trimmed"');
  }

  static String _validatePropertyKey(String key) {
    final trimmed = key.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError('property key cannot be empty');
    }
    if (_systemProps.contains(trimmed)) {
      return trimmed;
    }
    if (trimmed.length > maxPropKeyChars || !_identifierPattern.hasMatch(trimmed)) {
      throw ArgumentError('invalid property key "$trimmed"');
    }
    return trimmed;
  }

  static dynamic _sanitizeValue(String key, dynamic value) {
    if (value is String || value is bool) {
      return value;
    }
    if (value is int) {
      if (value > maxSafeInteger || value < -maxSafeInteger) {
        return value.toString();
      }
      return value;
    }
    if (value is double) {
      if (value.isNaN || value.isInfinite) {
        throw ArgumentError('property "$key" contains non-finite double');
      }
      return value;
    }
    if (value is DateTime) {
      return value.toUtc().toIso8601String();
    }
    if (value is List) {
      return value.map((elem) {
        if (elem == null || elem is List || elem is Map) {
          throw ArgumentError('property "$key" list contains null or nested element');
        }
        return _sanitizeValue(key, elem);
      }).toList();
    }
    throw ArgumentError('property "$key" has unsupported value type');
  }

  static int _normalizeEpochNumber(int n, String key) {
    if (n <= 0) {
      throw ArgumentError('property "$key" timestamp must be positive');
    }
    if (n >= 1000000000 && n < 100000000000) {
      return n * 1000;
    }
    return n;
  }

  static int _parseTimePropertyMs(String key, dynamic value) {
    if (value is DateTime) {
      final ms = value.millisecondsSinceEpoch;
      if (ms <= 0) {
        throw ArgumentError('property "$key" timestamp must be positive');
      }
      return ms;
    }
    if (value is int) {
      return _normalizeEpochNumber(value, key);
    }
    if (value is double) {
      if (value.isNaN || value.isInfinite || value <= 0) {
        throw ArgumentError('property "$key" contains invalid numeric timestamp');
      }
      if (value >= 1000000000 && value < 100000000000) {
        return (value * 1000).round();
      }
      return value.round();
    }
    if (value is String) {
      final s = value.trim();
      if (s.isEmpty) {
        throw ArgumentError('property "$key" timestamp string cannot be empty');
      }
      if (RegExp(r'^\d{10,16}$').hasMatch(s)) {
        return _normalizeEpochNumber(int.parse(s), key);
      }
      final parsed = DateTime.tryParse(s);
      if (parsed != null && parsed.millisecondsSinceEpoch > 0) {
        return parsed.millisecondsSinceEpoch;
      }
      throw ArgumentError('property "$key" has invalid ISO timestamp "$value"');
    }
    throw ArgumentError('property "$key" has unsupported time value type');
  }

  static Map<String, dynamic> _sanitizeProperties(Map<String, dynamic> props) {
    final out = <String, dynamic>{};
    props.forEach((rawKey, value) {
      final key = _validatePropertyKey(rawKey);
      if (value == null) return;
      out[key] = _sanitizeValue(key, value);
    });
    return out;
  }

  static String _generateUuidV4() {
    final rng = Random.secure();
    final bytes = List<int>.generate(16, (_) => rng.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    String hex(int b) => b.toRadixString(16).padLeft(2, '0');
    final h = bytes.map(hex).join();
    return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
  }
}
