package com.anylink.abi.sdk;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 内存暂存预览消费者（{@link StagingConsumer}）：实现 {@link Consumer} 接口，在内存中暂存待上报事件而不自动发起网络请求。
 *
 * <p>适用于服务端研发联调、参数自检与交互式工具场景，支持标准两步式接入工作流：
 * <ol>
 *   <li><b>配置参数并生成请求 JSON 预览</b>：通过 {@link AbiAnalytics} 调用埋点方法写入暂存队列，调用
 *       {@link #previewRequestJson(long, String, boolean)} 查看完整格式化的
 *       {@code POST /collect/api/v1/track/batch} 请求体；</li>
 *   <li><b>确认提交</b>：核对无误后调用 {@link #confirmSubmit(Consumer)} 将暂存事件一次性投递至真实的
 *       {@link BatchConsumer} 或 {@link DebugConsumer} 并刷新发送，随后自动清空暂存队列。</li>
 * </ol>
 */
public class StagingConsumer implements Consumer {
    private static final int DEFAULT_MAX_QUEUE_SIZE = 10000;
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final int maxQueueSize;
    private final List<Map<String, Object>> stagedEvents = new ArrayList<>();

    /**
     * 创建默认最大容量（10000 条）的内存暂存预览消费者。
     */
    public StagingConsumer() {
        this(DEFAULT_MAX_QUEUE_SIZE);
    }

    /**
     * 创建指定最大暂存容量的内存暂存预览消费者。
     *
     * @param maxQueueSize 最大可暂存事件条数（必须 {@code > 0}）
     */
    public StagingConsumer(int maxQueueSize) {
        if (maxQueueSize <= 0) {
            throw new IllegalArgumentException("maxQueueSize must be > 0");
        }
        this.maxQueueSize = maxQueueSize;
    }

    @Override
    public synchronized void add(Map<String, Object> eventRecord) {
        if (eventRecord == null) {
            throw new IllegalArgumentException("eventRecord must not be null");
        }
        if (stagedEvents.size() >= maxQueueSize) {
            throw new IllegalStateException("StagingConsumer queue is full (" + maxQueueSize + ")");
        }
        stagedEvents.add(copyEventRecord(eventRecord));
    }

    /**
     * 暂存消费者的 {@code flush()} 为空操作，不会发起任何网络请求，也不会清空待提交队列。
     */
    @Override
    public void flush() {
        // 暂存阶段不触发外部 I/O，保留待确认事件
    }

    /**
     * 关闭 {@link AbiAnalytics} 包装器时保留已暂存事件，以便在 {@code try-with-resources} 块结束后继续预览或确认提交。
     */
    @Override
    public void close() {
        // 保留已暂存事件直至显式调用 confirmSubmit 或 clear
    }

    /**
     * 返回当前暂存队列中的待提交事件条数。
     *
     * @return 待提交事件数量
     */
    public synchronized int size() {
        return stagedEvents.size();
    }

    /**
     * 获取当前已暂存事件的只读防御性拷贝列表。
     *
     * @return 待提交事件快照
     */
    public synchronized List<Map<String, Object>> getStagedEvents() {
        List<Map<String, Object>> snapshot = new ArrayList<>(stagedEvents.size());
        for (Map<String, Object> record : stagedEvents) {
            snapshot.add(copyEventRecord(record));
        }
        return Collections.unmodifiableList(snapshot);
    }

    /**
     * 组装 {@code POST /collect/api/v1/track/batch} 的完整请求载荷 Map（不清空暂存队列，也不发起网络请求）。
     *
     * @param projectId    ABI 项目 ID（必须 {@code > 0}）
     * @param projectToken ABI 项目采集鉴权 Token（非空白字符串）
     * @param dryRun       是否启用网关仅校验不落库（{@code dry_run}）模式
     * @return 包含 {@code project_id}、{@code project_token}、{@code dry_run} 与 {@code events} 的请求载荷快照
     */
    public synchronized Map<String, Object> buildRequestPayload(long projectId, String projectToken, boolean dryRun) {
        if (projectId <= 0 || projectToken == null || projectToken.isBlank()) {
            throw new IllegalArgumentException("projectId (> 0) and projectToken are required");
        }
        List<Map<String, Object>> eventsCopy = new ArrayList<>(stagedEvents.size());
        for (Map<String, Object> record : stagedEvents) {
            eventsCopy.add(copyEventRecord(record));
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("project_id", projectId);
        payload.put("project_token", projectToken.trim());
        payload.put("dry_run", dryRun);
        payload.put("events", eventsCopy);
        return payload;
    }

    /**
     * 生成带缩进格式化的 {@code POST /collect/api/v1/track/batch} 完整具体请求 JSON 字符串（仅预览，不清空队列）。
     *
     * @param projectId    ABI 项目 ID（必须 {@code > 0}）
     * @param projectToken ABI 项目采集鉴权 Token（非空白字符串）
     * @param dryRun       是否启用网关仅校验不落库（{@code dry_run}）模式
     * @return 缩进格式化后的完整请求 JSON 字符串
     */
    public synchronized String previewRequestJson(long projectId, String projectToken, boolean dryRun) {
        Map<String, Object> payload = buildRequestPayload(projectId, projectToken, dryRun);
        try {
            return MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(payload);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Failed to serialize staged request payload to JSON", ex);
        }
    }

    /**
     * 清空并重置当前所有待提交的暂存事件。
     */
    public synchronized void clear() {
        stagedEvents.clear();
    }

    /**
     * 确认提交：将当前暂存队列中的全部事件按序投递至目标消费者（如 {@link BatchConsumer} 或 {@link DebugConsumer}），
     * 执行 {@code targetConsumer.flush()} 触发实际发送，发送成功后清空暂存队列并返回本次提交的事件条数。
     *
     * @param targetConsumer 实际执行上报的目标 {@link Consumer}（不可为 {@code null} 或当前实例自身）
     * @return 本次确认提交并刷新的事件总条数
     * @throws Exception 目标消费者写入或网络刷新失败时抛出（失败时保留暂存队列以便排查或重试）
     */
    public synchronized int confirmSubmit(Consumer targetConsumer) throws Exception {
        if (targetConsumer == null) {
            throw new IllegalArgumentException("targetConsumer must not be null");
        }
        if (targetConsumer == this) {
            throw new IllegalArgumentException("targetConsumer must not be this StagingConsumer instance");
        }
        List<Map<String, Object>> snapshot = new ArrayList<>(stagedEvents.size());
        for (Map<String, Object> record : stagedEvents) {
            snapshot.add(copyEventRecord(record));
        }
        for (Map<String, Object> event : snapshot) {
            targetConsumer.add(event);
        }
        targetConsumer.flush();
        stagedEvents.clear();
        return snapshot.size();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> copyEventRecord(Map<String, Object> source) {
        Map<String, Object> copy = new LinkedHashMap<>(source);
        Object rawProps = source.get("properties");
        if (rawProps instanceof Map) {
            copy.put("properties", new LinkedHashMap<>((Map<String, Object>) rawProps));
        }
        return copy;
    }
}
