import 'dart:convert';
import 'package:flutter/material.dart';
import '../lib/abi_sdk.dart';

void main() {
  runApp(const AbiSdkDemoApp());
}

/// ABI 数据分析 Flutter SDK (`abi_sdk`) 交互式演练应用。
///
/// 采用与 Web `interactive-demo.html` 一致的两步式交互：
/// 1. 配置身份、静态/动态公共属性与业务/画像事件，原地实时预览唯一一份具体请求 JSON；
/// 2. 点击「确认提交」按钮触发发送，并在底部查看单次响应结果（无历史刷屏日志）。
class AbiSdkDemoApp extends StatelessWidget {
  const AbiSdkDemoApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ABI Flutter SDK 交互式演练',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF2563EB)),
        useMaterial3: true,
      ),
      home: const AbiSdkDemoScreen(),
    );
  }
}

class _StagedDraftAction {
  final String label;
  final void Function(AbiAnalytics sdk) apply;

  const _StagedDraftAction({
    required this.label,
    required this.apply,
  });
}

/// 提供参数配置、唯一待提交请求 JSON 实时预览与「确认提交」单次响应面板。
class AbiSdkDemoScreen extends StatefulWidget {
  const AbiSdkDemoScreen({super.key});

  @override
  State<AbiSdkDemoScreen> createState() => _AbiSdkDemoScreenState();
}

class _AbiSdkDemoScreenState extends State<AbiSdkDemoScreen> {
  static const String _serverUrl = 'http://localhost:8081';

  final AbiAnalytics _sdk = AbiAnalytics.instance;
  late final TextEditingController _superJsonController;

  String? _superJsonError;
  bool _dynamicSuperEnabled = false;
  int _dynamicSeq = 1;
  bool _appendBatchMode = false;
  bool _orderTimerRunning = false;
  bool _isSubmitting = false;

  String _lastOrderEventId = 'evt_order_demo_001';
  late List<_StagedDraftAction> _stagedActions;

  String _requestJsonPreview = '{}';
  String _responseStatusHint = '尚未提交';
  String _responsePreview = '点击上方「确认提交」按钮发送待提交请求 JSON，此处仅展示最近一次响应结果。';
  bool _responseIsError = false;

  @override
  void initState() {
    super.initState();
    _superJsonController = TextEditingController(
      text: '{\n  "app_channel": "Flutter_Demo",\n  "membership_tier": "Gold"\n}',
    );
    _sdk.init(const AbiConfig(
      serverUrl: _serverUrl,
      projectId: 1,
      projectToken: 'abi_tok_flutter_demo',
      appVersion: '2.1.0',
      batchSize: 50,
      dryRun: true,
      autoFlush: false, // 禁用后台定时器与 batchSize 自动发送，严格由「确认提交」触发
    ));
    _sdk.logout();
    _sdk.setSuperProperties({
      'app_channel': 'Flutter_Demo',
      'membership_tier': 'Gold',
    });
    _stagedActions = <_StagedDraftAction>[_createProductViewAction()];
    _rebuildDraftPreview();
  }

  @override
  void dispose() {
    _superJsonController.dispose();
    super.dispose();
  }

  _StagedDraftAction _createProductViewAction() {
    String? cachedEventId;
    return _StagedDraftAction(
      label: 'ProductView',
      apply: (sdk) {
        cachedEventId = sdk.track(
          'ProductView',
          eventId: cachedEventId,
          properties: const {
            'sku_id': 'sku_kb_pro',
            'product_name': 'ABI 无线双模机械键盘 Pro',
            'price': 199.0,
            'in_stock': true,
          },
        );
      },
    );
  }

  void _syncDynamicSuperProperties() {
    if (_dynamicSuperEnabled) {
      final seqSnapshot = _dynamicSeq;
      _sdk.setDynamicSuperProperties(() => <String, dynamic>{
            'dyn_sequence': seqSnapshot,
            'network_state': 'wifi',
          });
    } else {
      _sdk.setDynamicSuperProperties(null);
    }
  }

  void _ensureDefaultDraftIfEmpty() {
    if (_stagedActions.isEmpty) {
      _stagedActions = <_StagedDraftAction>[_createProductViewAction()];
    }
  }

  /// 基于当前身份、静态/动态公共属性与已选事件动作，原地重算唯一一份待提交请求 JSON。
  void _rebuildDraftPreview() {
    _sdk.clearPendingQueue();
    _syncDynamicSuperProperties();
    for (final action in _stagedActions) {
      action.apply(_sdk);
    }
    _requestJsonPreview =
        const JsonEncoder.withIndent('  ').convert(_sdk.buildPendingBatchPayload());
  }

  void _stageAction(_StagedDraftAction action) {
    setState(() {
      if (_appendBatchMode) {
        _stagedActions.add(action);
      } else {
        _stagedActions = <_StagedDraftAction>[action];
      }
      _rebuildDraftPreview();
    });
  }

  void _applyStaticSuperProperties() {
    final raw = _superJsonController.text.trim();
    final previousProps = _sdk.getSuperProperties();
    try {
      final decoded = raw.isEmpty ? <String, dynamic>{} : jsonDecode(raw);
      if (decoded is! Map) {
        throw const FormatException('请输入 JSON 对象（例如 {"channel": "flutter"}）');
      }
      final castMap = Map<String, dynamic>.from(decoded);
      _sdk.clearSuperProperties();
      _sdk.setSuperProperties(castMap);
      setState(() {
        _superJsonError = null;
        _ensureDefaultDraftIfEmpty();
        _rebuildDraftPreview();
      });
    } catch (e) {
      _sdk.clearSuperProperties();
      _sdk.setSuperProperties(previousProps);
      setState(() {
        _superJsonError = '静态公共属性格式或键名无效：$e';
      });
    }
  }

  Future<void> _handleConfirmSubmit() async {
    if (_isSubmitting || _sdk.pendingQueueLength == 0) return;
    final submittedCount = _sdk.pendingQueueLength;
    setState(() {
      _isSubmitting = true;
    });

    final ok = await _sdk.flush();
    final nowTime = DateTime.now().toIso8601String().substring(11, 19);
    final statusCode = _sdk.lastStatusCode;
    final rawBody = _sdk.lastResponseBody;

    String formattedBody = rawBody;
    if (rawBody.trim().isNotEmpty) {
      try {
        final parsed = jsonDecode(rawBody);
        formattedBody = const JsonEncoder.withIndent('  ').convert(parsed);
      } catch (_) {
        formattedBody = rawBody;
      }
    }

    if (!mounted) return;
    setState(() {
      _isSubmitting = false;
      if (ok) {
        if (_dynamicSuperEnabled) {
          _dynamicSeq += 1;
        }
        _stagedActions = <_StagedDraftAction>[];
        _rebuildDraftPreview();
        _responseIsError = false;
        _responseStatusHint = 'HTTP ${statusCode ?? 200} OK · 已提交 $submittedCount 条 · $nowTime';
        _responsePreview = formattedBody.isNotEmpty
            ? formattedBody
            : const JsonEncoder.withIndent('  ').convert({
                'code': 200,
                'message': '提交成功',
                'submitted_events': submittedCount,
              });
      } else {
        _responseIsError = true;
        final codeLabel = (statusCode == null || statusCode == 0) ? '网关未连接' : 'HTTP $statusCode';
        _responseStatusHint = '$codeLabel · 待重试 ${_sdk.pendingQueueLength} 条 · $nowTime';
        _responsePreview = '提交未完成（$codeLabel）：\n'
            '${formattedBody.isEmpty ? "无法连接 $_serverUrl/collect/api/v1/track/batch" : formattedBody}\n'
            '说明：若本地未启动 :8081 采集网关，SDK 已保留队列中的原始 event_id 供幂等重试。';
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('ABI Flutter SDK 交互式演练'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _buildIdentityStatusCard(),
          const SizedBox(height: 12),
          _buildIdentitySection(),
          const SizedBox(height: 12),
          _buildSuperPropertiesSection(),
          const SizedBox(height: 12),
          _buildBatchModeBar(),
          const SizedBox(height: 12),
          _buildBehaviorEventsSection(),
          const SizedBox(height: 12),
          _buildUserProfileSection(),
          const SizedBox(height: 16),
          _buildRequestPreviewPanel(),
          const SizedBox(height: 12),
          _buildResponsePanel(),
        ],
      ),
    );
  }

  Widget _buildIdentityStatusCard() {
    final superPropsJson = jsonEncode(_sdk.getSuperProperties());
    return Card(
      elevation: 1,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '当前 SDK 上下文状态（修改参数将原地重算下方请求 JSON）',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
            ),
            const SizedBox(height: 8),
            Text('访客标识 (distinct_id): ${_sdk.distinctId}'),
            Text('登录账号 ID (login_id): ${_sdk.loginId.isEmpty ? "(未登录)" : _sdk.loginId}'),
            Text('静态公共属性 (superProperties): $superPropsJson'),
            Text(
              '动态公共属性: ${_dynamicSuperEnabled ? "已启用 (dyn_sequence=$_dynamicSeq, network_state=wifi)" : "未启用"}',
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildIdentitySection() {
    return _buildSectionCard(
      title: '1. 身份与会话参数',
      subtitle: 'identify / login / logout 均为纯本地状态切换（不触发额外事件），原地同步待提交请求 JSON',
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          _actionButton('切换随机访客 ID (identify)', () {
            final customVisitor = 'visitor_fl_${DateTime.now().millisecondsSinceEpoch % 10000}';
            _sdk.identify(customVisitor);
            setState(() {
              _ensureDefaultDraftIfEmpty();
              _rebuildDraftPreview();
            });
          }),
          _actionButton('设置登录账号 (login)', () {
            _sdk.login('user_flutter_10001');
            setState(() {
              _ensureDefaultDraftIfEmpty();
              _rebuildDraftPreview();
            });
          }),
          _actionButton('退出登录 (logout)', () {
            _sdk.logout();
            setState(() {
              _ensureDefaultDraftIfEmpty();
              _rebuildDraftPreview();
            });
          }),
        ],
      ),
    );
  }

  Widget _buildSuperPropertiesSection() {
    return _buildSectionCard(
      title: '2. 公共属性配置 (Super Properties)',
      subtitle: '自动合并至非 \$user_* 事件，点击按钮实时刷新下方请求体',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _superJsonController,
            maxLines: 3,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5),
            decoration: const InputDecoration(
              labelText: '静态公共属性 JSON 对象 (setSuperProperties)',
              border: OutlineInputBorder(),
              isDense: true,
            ),
          ),
          if (_superJsonError != null) ...[
            const SizedBox(height: 6),
            Text(
              _superJsonError!,
              style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12),
            ),
          ],
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _actionButton('应用静态公共属性', _applyStaticSuperProperties),
              _actionButton(
                '启用动态公共属性：${_dynamicSuperEnabled ? "开" : "关"}',
                () {
                  setState(() {
                    _dynamicSuperEnabled = !_dynamicSuperEnabled;
                    if (_dynamicSuperEnabled) {
                      _dynamicSeq += 1;
                    }
                    _ensureDefaultDraftIfEmpty();
                    _rebuildDraftPreview();
                  });
                },
              ),
              _actionButton('清空公共属性', () {
                setState(() {
                  _superJsonError = null;
                  _dynamicSuperEnabled = false;
                  _sdk.clearSuperProperties();
                  _sdk.setDynamicSuperProperties(null);
                  _ensureDefaultDraftIfEmpty();
                  _rebuildDraftPreview();
                });
              }),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildBatchModeBar() {
    return Card(
      elevation: 0,
      color: Theme.of(context).colorScheme.secondaryContainer,
      child: SwitchListTile(
        dense: true,
        title: const Text(
          '多条拼批模式',
          style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
        ),
        subtitle: Text(
          _appendBatchMode
              ? '已开启：点击事件或画像按钮会追加到待提交 events 数组'
              : '未开启：每次点击仅构建并预览当前单条事件',
          style: const TextStyle(fontSize: 12),
        ),
        value: _appendBatchMode,
        onChanged: (val) {
          setState(() {
            _appendBatchMode = val;
          });
        },
      ),
    );
  }

  Widget _buildBehaviorEventsSection() {
    return _buildSectionCard(
      title: '3. 行为事件参数构建',
      subtitle: '点击构建待提交请求报文',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _actionButton('商品浏览事件 (ProductView)', () {
                _stageAction(_createProductViewAction());
              }),
              _actionButton('① 开始事件计时 (timeEvent)', () {
                _sdk.timeEvent('OrderPaid');
                setState(() {
                  _orderTimerRunning = true;
                });
              }),
              _actionButton('② 上报支付事件 (\$duration)', () {
                final hadRunningTimer = _orderTimerRunning;
                _orderTimerRunning = false;
                final orderNo = 'ord_${DateTime.now().millisecondsSinceEpoch % 100000}';
                String? cachedEventId;
                double? capturedDuration;
                _stageAction(
                  _StagedDraftAction(
                    label: 'OrderPaid(\$duration)',
                    apply: (sdk) {
                      if (capturedDuration == null && !hadRunningTimer) {
                        sdk.timeEvent('OrderPaid');
                      }
                      final id = sdk.track(
                        'OrderPaid',
                        eventId: cachedEventId,
                        properties: <String, dynamic>{
                          'order_id': orderNo,
                          'amount': 199.95,
                          'currency': 'CNY',
                          if (capturedDuration != null) '\$duration': capturedDuration,
                        },
                      );
                      cachedEventId = id;
                      _lastOrderEventId = id;
                      if (capturedDuration == null) {
                        final events = sdk.buildPendingBatchPayload()['events'] as List<dynamic>;
                        if (events.isNotEmpty) {
                          final lastProps =
                              (events.last as Map<String, dynamic>)['properties'] as Map<String, dynamic>?;
                          final dur = lastProps?['\$duration'];
                          if (dur is num) {
                            capturedDuration = dur.toDouble();
                          }
                        }
                      }
                    },
                  ),
                );
              }),
              _actionButton('64 位雪花大整数 (> 2^53-1)', () {
                String? cachedEventId;
                _stageAction(
                  _StagedDraftAction(
                    label: 'OrderPaid(BigInt)',
                    apply: (sdk) {
                      cachedEventId = sdk.track(
                        'OrderPaid',
                        eventId: cachedEventId,
                        properties: const {
                          'order_id': 'ord_snowflake_01',
                          'snowflake_seq': 9007199254740993,
                          'amount': 299.0,
                        },
                      );
                    },
                  ),
                );
              }),
              _actionButton('固定 eventId 幂等事件 (OrderSettled)', () {
                _stageAction(
                  _StagedDraftAction(
                    label: 'OrderSettled(eventId)',
                    apply: (sdk) {
                      sdk.track(
                        'OrderSettled',
                        eventId: 'evt_flutter_order_settled_01',
                        properties: const {
                          'order_id': 'ord_snowflake_01',
                          'order_status': 'settled',
                          'amount': 199.95,
                        },
                      );
                    },
                  ),
                );
              }),
            ],
          ),
          if (_orderTimerRunning) ...[
            const SizedBox(height: 8),
            const Text(
              '⏱ OrderPaid 秒表计时中：点击「② 上报支付事件 (\$duration)」即可将实测耗时写入下方请求 JSON。',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildUserProfileSection() {
    return _buildSectionCard(
      title: '4. 用户画像操作参数构建 (\$user_*)',
      subtitle: '自动隔离公共属性 · 对应 abi.dim_users',
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          _actionButton('覆盖设置画像 (userSet)', () {
            _stageAction(
              _StagedDraftAction(
                label: 'userSet',
                apply: (sdk) => sdk.userSet(const {'vip_level': 'Platinum', 'city': 'Shanghai'}),
              ),
            );
          }),
          _actionButton('首次设置画像 (userSetOnce)', () {
            _stageAction(
              _StagedDraftAction(
                label: 'userSetOnce',
                apply: (sdk) => sdk.userSetOnce(const {'first_install_source': 'AppStore'}),
              ),
            );
          }),
          _actionButton('数值累加画像 (userAdd +100)', () {
            _stageAction(
              _StagedDraftAction(
                label: 'userAdd',
                apply: (sdk) => sdk.userAdd(const {'loyalty_points': 100}),
              ),
            );
          }),
          _actionButton('列表追加画像 (userAppend)', () {
            _stageAction(
              _StagedDraftAction(
                label: 'userAppend',
                apply: (sdk) => sdk.userAppend(const {
                  'tags': ['mobile_shopper', 'promo_2026'],
                }),
              ),
            );
          }),
          _actionButton('列表去重追加 (userUniqAppend)', () {
            _stageAction(
              _StagedDraftAction(
                label: 'userUniqAppend',
                apply: (sdk) => sdk.userUniqAppend(const {
                  'tags': ['promo_2026', 'vip_member'],
                }),
              ),
            );
          }),
          _actionButton('清空指定画像 (userUnset)', () {
            _stageAction(
              _StagedDraftAction(
                label: 'userUnset',
                apply: (sdk) => sdk.userUnset(const ['temporary_flag']),
              ),
            );
          }),
          _actionButton('删除用户画像 (userDelete)', () {
            _stageAction(
              _StagedDraftAction(
                label: 'userDelete',
                apply: (sdk) => sdk.userDelete(),
              ),
            );
          }),
        ],
      ),
    );
  }

  /// 面板 A：待提交请求 JSON 预览 + 重置待发参数 + 确认提交主按钮。
  Widget _buildRequestPreviewPanel() {
    final pendingCount = _sdk.pendingQueueLength;
    return Card(
      elevation: 1,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        '面板 A：待提交请求 JSON 预览 (POST /collect/api/v1/track/batch)',
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '当前共 $pendingCount 条待提交事件 · Endpoint: $_serverUrl/collect/api/v1/track/batch',
                        style: const TextStyle(fontSize: 12),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 10,
              runSpacing: 8,
              children: [
                OutlinedButton(
                  onPressed: () {
                    setState(() {
                      _orderTimerRunning = false;
                      _stagedActions = <_StagedDraftAction>[_createProductViewAction()];
                      _rebuildDraftPreview();
                    });
                  },
                  child: const Text('重置待发参数'),
                ),
                FilledButton(
                  onPressed: (_isSubmitting || pendingCount == 0) ? null : _handleConfirmSubmit,
                  child: Text(_isSubmitting ? '提交中...' : '确认提交'),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFF0F172A),
                borderRadius: BorderRadius.circular(8),
              ),
              child: SelectableText(
                _requestJsonPreview,
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12,
                  color: Color(0xFFE2E8F0),
                  height: 1.45,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 面板 B：最近一次提交结果（仅在点击「确认提交」后更新）。
  Widget _buildResponsePanel() {
    return Card(
      elevation: 1,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  '面板 B：最近一次提交结果 (Response)',
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                ),
                Flexible(
                  child: Text(
                    _responseStatusHint,
                    style: TextStyle(
                      fontSize: 12,
                      color: _responseIsError
                          ? Theme.of(context).colorScheme.error
                          : Theme.of(context).colorScheme.primary,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFF0F172A),
                borderRadius: BorderRadius.circular(8),
              ),
              child: SelectableText(
                _responsePreview,
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12,
                  color: _responseIsError ? const Color(0xFFFDA4AF) : const Color(0xFFA7F3D0),
                  height: 1.45,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSectionCard({
    required String title,
    required String subtitle,
    required Widget child,
  }) {
    return Card(
      elevation: 0,
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
            const SizedBox(height: 2),
            Text(subtitle, style: const TextStyle(fontSize: 12)),
            const SizedBox(height: 10),
            child,
          ],
        ),
      ),
    );
  }

  Widget _actionButton(String label, VoidCallback onPressed) {
    return FilledButton.tonal(
      onPressed: onPressed,
      child: Text(label),
    );
  }
}
