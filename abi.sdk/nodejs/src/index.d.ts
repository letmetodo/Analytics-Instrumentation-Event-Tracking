/**
 * ABI Node.js 服务端数据采集 SDK (`@anylink/abi-node-sdk`) TypeScript 类型声明定义。
 * 对标数数科技 ThinkingData Node.js Server SDK v3.4。
 */

export const SDK_NAME: 'abi-node-sdk';
export const SDK_VERSION: '1.0.0';
export const USER_AGENT: 'abi-node-sdk/1.0.0';
export const MAX_DISTINCT_ID_BYTES: 64;
export const MAX_LOGIN_ID_BYTES: 128;
export const MAX_EVENT_ID_BYTES: 64;
export const MAX_EVENT_NAME_LEN: 128;
export const MAX_PROP_KEY_LEN: 64;
export const MAX_SAFE_INT: 9007199254740991;
export const MIN_SAFE_INT: -9007199254740991;

export const RotateMode: Readonly<{
  readonly DAILY: 'DAILY';
  readonly HOURLY: 'HOURLY';
}>;

export type RotateModeValue = (typeof RotateMode)[keyof typeof RotateMode];

export const PROTECTED_SYSTEM_EVENTS: ReadonlySet<string>;
export const PROTECTED_SYSTEM_PROP_ALIASES: ReadonlySet<string>;

/**
 * 单条上报事件标准传输结构（对应 `POST /collect/api/v1/track/batch` 的 `events[]` 元素）。
 */
export interface TrackEventDTO {
  event_id: string;
  event_name: string;
  distinct_id: string;
  login_id?: string;
  timestamp: number;
  properties: Record<string, unknown>;
}

/**
 * 批量上报请求负载结构（对应 `POST /collect/api/v1/track/batch` 请求体）。
 */
export interface TrackBatchPayload {
  project_id: number;
  project_token: string;
  debug?: boolean;
  dry_run?: boolean;
  events: TrackEventDTO[];
}

/**
 * 网关 Debug 模式下返回的单条事件校验失败错误项。
 */
export interface TrackEventError {
  index: number;
  event_id?: string;
  event_name?: string;
  reason: string;
}

/**
 * ABI 采集网关标准 HTTP JSON 响应信封。
 */
export interface GatewayEnvelope {
  code: number;
  message: string;
  request_id: string;
  data: {
    accepted: number;
    rejected: number;
    dry_run?: boolean;
    errors?: TrackEventError[];
  };
}

/**
 * 底层 HTTP 传输层响应结构。
 */
export interface AbiHttpTransportResponse {
  status: number;
  bodyText: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * 自定义 HTTP 传输适配器函数签名。
 */
export type AbiHttpTransportFn = (
  endpoint: string,
  headers: Record<string, string>,
  bodyBuffer: Buffer,
  timeoutMs?: number,
) => Promise<AbiHttpTransportResponse>;

/**
 * 可插拔事件传输消费者统一接口。
 */
export interface AbiConsumer {
  add(event: TrackEventDTO): void | Promise<unknown>;
  flush?(): Promise<unknown>;
  close?(): Promise<unknown>;
}

/**
 * 规范化后的用户身份标识结构。
 */
export interface NormalizedIdentity {
  distinctId: string;
  loginId: string;
  distinct_id: string;
  login_id: string;
}

/**
 * 身份标识输入对象。
 */
export interface IdentityInput {
  distinctId?: string;
  distinct_id?: string;
  loginId?: string;
  login_id?: string;
  accountId?: string;
  account_id?: string;
}

/**
 * 事件发生时间输入类型（`Date` 实例、秒/毫秒级正整数时间戳、或可解析的 ISO-8601 / `YYYY-MM-DD HH:mm:ss` 日期字符串）。
 */
export type AbiEventTimeInput = Date | number | bigint | string;

export function utf8ByteLength(value: string): number;
export function containsDisallowedControlChar(value: string): boolean;
export function generateUUIDv4(): string;
export function normalizeIdentityField(
  raw: string,
  maxBytes: number,
  fieldName?: string,
  allowEmpty?: boolean,
): string;
export function normalizeIdentity(
  distinctIdOrInput: string | IdentityInput,
  loginId?: string,
): NormalizedIdentity;
export function validateEventName(eventName: string): string;
export function validatePropertyKey(propKey: string): string;
export function formatDateForABI(date: Date): string;
export function normalizePropertyValue(propKey: string, value: unknown): unknown;
export function normalizeProperties(
  props?: Record<string, unknown> | null,
): Record<string, unknown>;
export function parseEventTimestamp(key: string, raw: unknown): number;
export function resolveBatchEndpoint(rawUrl: string): string;
export const defaultNodeHttpTransport: AbiHttpTransportFn;

/**
 * `StagingConsumer` 初始化配置。
 */
export interface StagingConsumerConfig {
  projectId?: number;
  project_id?: number;
  projectToken?: string;
  project_token?: string;
  token?: string;
  debug?: boolean;
  dryRun?: boolean;
  dry_run?: boolean;
  serverUrl?: string;
  server_url?: string;
  compressGzip?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  transport?: AbiHttpTransportFn;
}

/**
 * `StagingConsumer.submitToGateway` 提交配置。
 */
export interface StagingSubmitConfig {
  serverUrl?: string;
  projectId?: number;
  projectToken?: string;
  token?: string;
  compressGzip?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  transport?: AbiHttpTransportFn;
}

/**
 * 两步式预览请求 JSON 与确认提交消费者。
 */
export class StagingConsumer implements AbiConsumer {
  projectId: number;
  projectToken: string;
  debug: boolean;
  dryRun: boolean;
  serverUrl: string;
  compressGzip: boolean;
  timeoutMs: number;
  maxRetries: number;
  transport: AbiHttpTransportFn;
  events: TrackEventDTO[];

  constructor(
    optionsOrProjectId?: StagingConsumerConfig | number,
    projectToken?: string,
    dryRun?: boolean,
  );
  add(event: TrackEventDTO): void;
  setDebug(debug: boolean): void;
  setDryRun(dryRun: boolean): void;
  clear(): void;
  reset(): void;
  getEvents(): TrackEventDTO[];
  buildRequestPayload(): TrackBatchPayload;
  previewRequestJson(): string;
  previewRequestJSON(): string;
  confirmSubmit(targetConsumer: AbiConsumer | StagingSubmitConfig): Promise<unknown>;
  submitToGateway(config?: StagingSubmitConfig): Promise<GatewayEnvelope>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * `BatchConsumer` 初始化配置。
 */
export interface BatchConsumerConfig {
  serverUrl: string;
  projectId: number;
  projectToken?: string;
  token?: string;
  batchSize?: number;
  maxBatchSize?: number;
  flushIntervalMs?: number;
  maxCacheSize?: number;
  maxQueueSize?: number;
  timeoutMs?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  compressGzip?: boolean;
  dryRun?: boolean;
  debug?: boolean;
  onError?: (err: Error, droppedEvents: TrackEventDTO[]) => void;
  transport?: AbiHttpTransportFn;
}

/**
 * 生产高吞吐异步批量上报消费者（支持 `zlib.gzipSync` 压缩与 `429`/`5xx` 指数退避幂等重试）。
 */
export class BatchConsumer implements AbiConsumer {
  endpoint: string;
  projectId: number;
  projectToken: string;
  batchSize: number;
  flushIntervalMs: number;
  maxCacheSize: number;
  timeoutMs: number;
  maxRetries: number;
  baseRetryDelayMs: number;
  compressGzip: boolean;
  dryRun: boolean;
  debug: boolean;
  buffer: TrackEventDTO[];
  closed: boolean;

  constructor(config: BatchConsumerConfig);
  add(event: TrackEventDTO): void;
  flush(): Promise<GatewayEnvelope | null>;
  close(): Promise<GatewayEnvelope | null>;
}

/**
 * `LoggerConsumer` 初始化配置。
 */
export interface LoggerConsumerConfig {
  directory: string;
  filePrefix?: string;
  rotateMode?: RotateModeValue;
  maxFileSizeMB?: number;
  maxFileSizeBytes?: number;
  useUTC?: boolean;
  nowFn?: () => Date;
}

/**
 * 本地 JSONL（`.jsonl`）按天/按小时切分落盘消费者（供 Filebeat / Vector / LogBus 采集）。
 */
export class LoggerConsumer implements AbiConsumer {
  directory: string;
  filePrefix: string;
  rotateMode: RotateModeValue;
  maxFileSizeBytes: number;
  useUTC: boolean;
  currentPeriod: string;
  currentIndex: number;
  currentBytes: number;
  currentFilePath: string;
  closed: boolean;

  constructor(config: LoggerConsumerConfig);
  add(event: TrackEventDTO): void;
  getFilePath(): string;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * `DebugConsumer` 初始化配置。
 */
export interface DebugConsumerConfig {
  serverUrl: string;
  projectId: number;
  projectToken?: string;
  token?: string;
  dryRun?: boolean;
  timeoutMs?: number;
  transport?: AbiHttpTransportFn;
}

/**
 * 研发期实时同步 L4 强校验消费者（固定携带 `debug: true`，可选 `dryRun: true`）。
 */
export class DebugConsumer implements AbiConsumer {
  endpoint: string;
  projectId: number;
  projectToken: string;
  dryRun: boolean;
  timeoutMs: number;

  constructor(config: DebugConsumerConfig);
  add(event: TrackEventDTO): Promise<GatewayEnvelope>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 位置签名调用时的附加可选参数。
 */
export interface TrackCallOptions {
  distinctId?: string;
  loginId?: string;
  accountId?: string;
  eventId?: string;
  timestamp?: AbiEventTimeInput;
}

/**
 * 对象签名调用 `track()` / `trackWithOptions()` 的参数结构。
 */
export interface TrackInput extends IdentityInput {
  eventName: string;
  properties?: Record<string, unknown>;
  eventId?: string;
  timestamp?: AbiEventTimeInput;
}

/**
 * 对象签名调用 `trackFirst()` 的参数结构。
 */
export interface TrackFirstInput extends TrackInput {
  firstCheckId: string;
}

/**
 * 对象签名调用 `trackUpdate()` / `trackOverwrite()` 的参数结构。
 */
export interface TrackMutableInput extends TrackInput {
  eventId: string;
}

/**
 * 对象签名调用 `userSet` / `userSetOnce` / `userAdd` / `userAppend` / `userUniqAppend` 的参数结构。
 */
export interface UserProfileInput extends IdentityInput {
  properties: Record<string, unknown>;
  eventId?: string;
  timestamp?: AbiEventTimeInput;
}

/**
 * 对象签名调用 `userUnset` 的参数结构。
 */
export interface UserUnsetInput extends IdentityInput {
  keys?: string[];
  properties?: Record<string, unknown>;
  eventId?: string;
  timestamp?: AbiEventTimeInput;
}

/**
 * 对象签名调用 `userDelete` 的参数结构。
 */
export interface UserDeleteInput extends IdentityInput {
  eventId?: string;
  timestamp?: AbiEventTimeInput;
}

/**
 * ABI Node.js 服务端无状态多用户行为分析核心客户端。
 */
export class AbiNodeAnalytics {
  consumer: AbiConsumer;
  superProperties: Record<string, unknown>;
  dynamicSuperPropsFn: (() => Record<string, unknown>) | null;

  constructor(consumer: AbiConsumer);

  setSuperProperties(props: Record<string, unknown>): void;
  unsetSuperProperty(key: string): void;
  clearSuperProperties(): void;
  getSuperProperties(): Record<string, unknown>;
  setDynamicSuperProperties(fn: (() => Record<string, unknown>) | null | undefined): void;

  track(input: TrackInput): string | Promise<string>;
  track(
    loginId: string,
    distinctId: string,
    eventName: string,
    properties?: Record<string, unknown>,
    options?: TrackCallOptions,
  ): string | Promise<string>;

  trackWithOptions(options: TrackInput): string | Promise<string>;

  /** @deprecated [当前版本未开放 / Unsupported in current version] (D7① / G6 gate) */
  trackFirst(input: TrackFirstInput): string | Promise<string>;
  /** @deprecated [当前版本未开放 / Unsupported in current version] (D7① / G6 gate) */
  trackFirst(
    loginId: string,
    distinctId: string,
    eventName: string,
    firstCheckId: string,
    properties?: Record<string, unknown>,
    options?: TrackCallOptions,
  ): string | Promise<string>;

  /** @deprecated [当前版本未开放 / Unsupported in current version] (D7① / G6 gate) */
  trackUpdate(input: TrackMutableInput): string | Promise<string>;
  /** @deprecated [当前版本未开放 / Unsupported in current version] (D7① / G6 gate) */
  trackUpdate(
    loginId: string,
    distinctId: string,
    eventName: string,
    eventId: string,
    properties?: Record<string, unknown>,
    options?: TrackCallOptions,
  ): string | Promise<string>;

  /** @deprecated [当前版本未开放 / Unsupported in current version] (D7① / G6 gate) */
  trackOverwrite(input: TrackMutableInput): string | Promise<string>;
  /** @deprecated [当前版本未开放 / Unsupported in current version] (D7① / G6 gate) */
  trackOverwrite(
    loginId: string,
    distinctId: string,
    eventName: string,
    eventId: string,
    properties?: Record<string, unknown>,
    options?: TrackCallOptions,
  ): string | Promise<string>;

  userSet(input: UserProfileInput): string | Promise<string>;
  userSet(
    loginId: string,
    distinctId: string,
    properties: Record<string, unknown>,
    options?: TrackCallOptions,
  ): string | Promise<string>;

  userSetOnce(input: UserProfileInput): string | Promise<string>;
  userSetOnce(
    loginId: string,
    distinctId: string,
    properties: Record<string, unknown>,
    options?: TrackCallOptions,
  ): string | Promise<string>;

  userAdd(input: UserProfileInput): string | Promise<string>;
  userAdd(
    loginId: string,
    distinctId: string,
    properties: Record<string, unknown>,
    options?: TrackCallOptions,
  ): string | Promise<string>;

  userAppend(input: UserProfileInput): string | Promise<string>;
  userAppend(
    loginId: string,
    distinctId: string,
    properties: Record<string, unknown>,
    options?: TrackCallOptions,
  ): string | Promise<string>;

  userUniqAppend(input: UserProfileInput): string | Promise<string>;
  userUniqAppend(
    loginId: string,
    distinctId: string,
    properties: Record<string, unknown>,
    options?: TrackCallOptions,
  ): string | Promise<string>;

  userUnset(input: UserUnsetInput): string | Promise<string>;
  userUnset(
    loginId: string,
    distinctId: string,
    ...keys: Array<string | string[]>
  ): string | Promise<string>;

  userDelete(input: UserDeleteInput): string | Promise<string>;
  userDelete(
    loginId: string,
    distinctId?: string,
    options?: TrackCallOptions,
  ): string | Promise<string>;

  flush(): Promise<unknown>;
  close(): Promise<unknown>;
}

export default AbiNodeAnalytics;
