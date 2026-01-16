# RocketMQ 顺序消费与并发消费实现机制（开发者视角）

> 本文基于 RocketMQ 4.9.3-SNAPSHOT 版本，深入对比 ConsumeMessageOrderlyService 与 ConsumeMessageConcurrentlyService 的核心实现差异、线程模型及可靠性保障。

---

## 1. 消费模式概览

RocketMQ 提供两种消息消费模式：

| 模式 | 类名 | 特点 |
|------|------|------|
| 顺序消费 | ConsumeMessageOrderlyService | 保证单队列内消息全局有序，同一 Queue 同一时刻仅被一个线程处理 |
| 并发消费 | ConsumeMessageConcurrentlyService | 多线程并行处理消息，不保证顺序，吞吐量更高 |

两者均通过 ConsumeMessageService 接口抽象，核心入口为 submitConsumeRequest 方法。

---

## 2. 公共基础：消费任务提交

无论哪种模式，消息拉取后均由 PushConsumerImpl 调用 submitConsumeRequest 提交消费任务。该方法接收消息列表、ProcessQueue、MessageQueue 和是否允许消费的标志。

- ProcessQueue：内存中的消息处理队列，维护消息状态（如是否已消费、重试次数）
- MessageQueue：逻辑队列（Topic + Broker + QueueId）
- dispatchToConsume：若队列未锁定（如负载均衡期间），则设为 false，暂停消费

后续逻辑由具体实现类决定。

---

## 3. 顺序消费实现（ConsumeMessageOrderlyService）

### 3.1 核心约束

顺序消费的“有序性”依赖两个前提：
1. 队列级串行：同一 MessageQueue 同一时间只能被一个线程消费
2. Broker 锁定：在集群模式下，消费者必须成功向 Broker 申请该队列的分布式锁

注意：顺序消费仅保证单队列内有序，不保证 Topic 全局有序。若需全局有序，应将 Topic 配置为单队列。

### 3.2 消费流程（ConsumeRequest.run）

1. 检查队列状态：若 processQueue.isDropped()（因负载均衡触发），直接退出
2. 获取队列锁：使用 messageQueueLock.fetchLockObject(mq) 获取对象锁，确保单队列串行
3. 验证锁有效性（集群模式）：必须满足 processQueue.isLocked() 且 !processQueue.isLockExpired()，否则调用 tryLockLaterAndReconsume 延迟重试
4. 批量拉取消息：从 ProcessQueue 的 TreeMap（以 commitLog offset 为 key）中按序取出，默认 1 条
5. 调用业务 Listener：执行 messageListener.consumeMessage(msgs, context)，并加 processQueue.getConsumeLock() 防止并发修改
6. 处理消费结果：根据返回值 ConsumeOrderlyStatus 决定后续动作

### 3.3 消费结果处理（processConsumeResult）

- 返回 SUCCESS 或 COMMIT：提交 offset，继续消费
- 返回 SUSPEND_CURRENT_QUEUE_A_MOMENT：检查重试次数。未超限则消息重新入队延迟重试；超限则发往死信队列（DLQ），并提交 offset
- 返回 ROLLBACK：效果同 SUSPEND...

重试策略特殊：默认最大重试次数为 Integer.MAX_VALUE（即无限重试），防止乱序。强烈建议业务方监控重试次数，避免因个别消息失败导致队列阻塞堆积。

---

## 4. 并发消费实现（ConsumeMessageConcurrentlyService）

### 4.1 线程模型

- 使用 ThreadPoolExecutor，默认核心/最大线程数均为 20
- 阻塞队列：LinkedBlockingQueue（无界队列）
- 拒绝策略：默认 AbortPolicy，但 RocketMQ 在 submit 失败时会自动延迟重试

风险：若消费速度远低于拉取速度，无界队列可能导致 OOM。

### 4.2 消息分批提交

submitConsumeRequest 会对消息按 consumeMessageBatchMaxSize（默认 1）分批：
- 若消息数 ≤ batchMaxSize：整批提交为一个 ConsumeRequest
- 否则：拆分为多个批次，分别提交

优化建议：适当增大 consumeMessageBatchMaxSize 可提升吞吐，但需处理部分失败场景。

### 4.3 消费结果处理（processConsumeResult）

通过 ConsumeConcurrentlyContext.setAckIndex(index) 控制 ACK 行为：
- ackIndex >= msgs.size() - 1：全部成功，移除全部消息，提交最小未消费 offset
- ackIndex = i（0 ≤ i < size）：[0..i] 成功，[i+1..end] 失败
- ackIndex = -1：全部失败，所有消息发回 Broker 重试

关键机制：offset 提交策略  
调用 processQueue.removeMessage 后返回当前最小未消费消息的 offset。即使只消费了 offset=5 的消息，若队列中仍有 [1,2,3,4]，提交的 offset 仍是 1，目的是防止消息丢失。

重试机制：  
失败消息通过 sendMessageBack 发回 Broker，进入重试 Topic（%RETRY%groupName）。最多重试 16 次（第 16 次后进入 DLQ），每次重试间隔按指数退避增长（10s, 30s, 1m, 2m...）。

---

## 5. 关键差异对比

| 维度 | 顺序消费 | 并发消费 |
|------|----------|----------|
| 顺序保证 | 单队列严格有序 | 无序 |
| 并发度 | 每队列 1 线程 | 多线程并行 |
| 吞吐量 | 较低 | 高 |
| 重试上限 | 默认 Integer.MAX_VALUE（可配置） | 固定 16 次 |
| 失败影响 | 阻塞整个队列 | 仅影响失败消息 |
| 适用场景 | 订单状态变更、binlog 同步等强顺序场景 | 日志处理、通知推送等无序场景 |

---

## 6. 开发者建议

### 顺序消费
- 避免长时间阻塞：业务处理超时（默认 60s）会中断消费，触发重试
- 主动放行失败消息：在重试 N 次后返回 SUCCESS，防止队列卡死
- 监控重试次数：通过 msg.getReconsumeTimes() 判断

### 并发消费
- 谨慎设置 batch size：大批次需处理部分失败，避免全批重试
- 控制线程池：根据机器资源调整 consumeThreadMin/Max
- 避免无界堆积：监控 consumeRequestQueue 长度，必要时限流

---

## 总结

RocketMQ 通过两套独立的消费服务实现顺序与并发语义：
- 顺序消费以牺牲吞吐换取强一致性，适用于对顺序敏感的核心链路；
- 并发消费追求高吞吐与容错性，适合大多数通用场景。

选择哪种模式，应基于业务对顺序性、吞吐量、容错能力的权衡。错误使用顺序消费（如未处理失败消息）极易引发消息堆积，需格外谨慎。

> 源码入口：  
> - 顺序消费：org.apache.rocketmq.client.impl.consumer.ConsumeMessageOrderlyService  
> - 并发消费：org.apache.rocketmq.client.impl.consumer.ConsumeMessageConcurrentlyService