# RocketMQ 延时消息实现机制（开发者视角）

> 本文基于 RocketMQ 4.9.3-SNAPSHOT 版本，聚焦延时消息的核心实现逻辑、关键组件及可靠性保障。

---

## 1. 核心设计思想

RocketMQ 的延时消息并非真正“延迟投递”，而是采用 **“暂存 + 定时回放”** 的策略：

- 当 Producer 发送一条延时消息（指定 `delayLevel > 0`），Broker **不会将其写入目标 Topic**。
- 而是将消息重定向至系统保留 Topic：`SCHEDULE_TOPIC_XXXX`，并根据 `delayLevel` 写入对应的内部队列（Queue ID = delayLevel - 1）。
- 消息的原始 Topic、QueueId 等元数据被暂存于消息属性中，同时将 **预期投递时间戳**（`storeTimestamp + delayTimeMillis`）编码到 `tagsCode` 字段。
- 后台服务 `ScheduleMessageService` 定期扫描各延时队列，一旦消息到达投递时间，即还原其原始信息，并作为普通消息重新投递至目标 Topic。

> ✅ 优势：复用现有存储与投递链路，无需引入独立定时调度系统。  
> ⚠️ 限制：延时时间由预定义级别决定，不支持任意时间点。

---

## 2. 关键组件解析

### 2.1 `ScheduleMessageService`

延时消息的核心服务，运行于 Broker 主进程中，负责：
- 启动延时队列扫描任务
- 管理各 Level 的消费进度（offset）
- 执行消息回放与持久化

### 2.2 延时级别映射（`delayLevelTable`）

通过 `messageDelayLevel` 配置项定义（默认）：

```
messageDelayLevel=1s 5s 10s 30s 1m 2m 3m 4m 5m 6m 7m 8m 9m 10m 20m 30m 1h 2h
```

- 共 18 个级别，Level 1 对应 1 秒，Level 18 对应 2 小时。
- 每个 Level 对应 `SCHEDULE_TOPIC_XXXX` 中的一个 Queue。

### 2.3 消费进度管理（`offsetTable`）

- Map 结构：`<level, offset>`
- 记录每个延时队列当前已处理到的位置。
- 启动时从磁盘加载，运行时定期持久化，防止重复投递或丢失。

### 2.4 消息存储与恢复

- 原始消息仍写入 CommitLog，仅 Topic/Queue 被替换。
- 回放时通过 `DefaultMessageStore` 读取完整消息体，还原：
  - `topic` → 原始 Topic
  - `queueId` → 原始 Queue ID
  - `tagsCode` → 原始 Tag hash 值
- 重新调用 `putMessage` 写入目标 Topic，走标准投递流程。

---

## 3. 服务启动流程

`ScheduleMessageService#start()` 执行以下初始化：

1. **创建定时器线程池**（单线程 `Timer`）
2. **加载 offset 快照**：从 `${storePathRootDir}/config/delayOffset.json` 读取各 Level 的最新 offset
3. **为每个 delayLevel 启动一个 `DeliverDelayedMessageTimerTask`**
   - 首次调度延迟 1 秒（`FIRST_DELAY_TIME = 1000ms`）
4. **注册周期性持久化任务**：每 10 秒将 `offsetTable` 写入磁盘

---

## 4. 消息投递流程（`DeliverDelayedMessageTimerTask`）

每个 Level 对应一个独立任务，执行逻辑如下：

### 步骤 1：定位消费队列
- Topic: `SCHEDULE_TOPIC_XXXX`
- QueueId: `level - 1`

### 步骤 2：读取消息索引
- 从 `ConsumeQueue` 读取一批消息索引（默认 32 条）
- 每条索引包含：CommitLog offset、size、tagsCode（实际为投递时间戳）

### 步骤 3：逐条处理

对每条消息：

```
long deliverTimestamp = tagsCode; // 实际存储的是投递时间戳
long now = System.currentTimeMillis();
long countdown = deliverTimestamp - now;
```

#### 情况 A：`countdown <= 0`（可投递）
- 从 CommitLog 加载完整消息
- 还原原始 Topic/QueueId/Tag
- 调用 `DefaultMessageStore#putMessage` 重新投递
- 成功后更新 offset，继续下一条

#### 情况 B：`countdown > 0`（未到期）
- 计算剩余等待时间 `countdown`
- **提交新任务**：`timer.schedule(new DeliverDelayedMessageTimerTask(...), countdown)`
- **立即退出当前任务**（非周期任务）

> 🔁 注意：每次任务执行完毕（无论成功与否），都会主动触发下一次调度，确保持续检查。

### 异常处理
- 消息读取失败、写入失败等异常会记录 WARN 日志
- offset 不推进，**10 秒后重试**（通过 `nextDelayTime` 控制）

---

## 5. Offset 持久化机制（防丢失关键）

为避免 Broker 宕机导致重复投递，offset 采用 **原子写入 + 备份** 策略：

1. 写入临时文件：`delayOffset.json.tmp`
2. 备份原文件：`delayOffset.json → delayOffset.json.bak`
3. 删除原文件，重命名 `.tmp` 为正式文件

该流程确保即使在写入过程中崩溃，也能通过 `.bak` 或 `.tmp` 恢复最近有效状态。

---

## 6. 开发者注意事项

| 问题 | 说明 |
|------|------|
| **不支持任意延时** | 只能使用预定义的 delayLevel，无法指定“37秒后投递” |
| **最大延时有限** | 默认最大 2 小时，可通过修改 `messageDelayLevel` 扩展（但需评估性能） |
| **消息可见性延迟** | 即使设置 1s 延时，实际投递可能因扫描间隔略有偏差（通常 < 100ms） |
| **监控建议** | 关注 `SCHEDULE_TOPIC_XXXX` 的堆积情况，以及 `ScheduleMessageService` 日志中的 WARN |

---

## 总结

RocketMQ 通过 **内部 Topic + 队列隔离 + 定时回放** 的方式，在不破坏现有架构的前提下实现了可靠的延时消息功能。其设计兼顾了性能、一致性与可运维性，适合大多数“分钟级”延迟场景。对于更高精度或更长延迟需求，建议结合外部调度系统（如 Quartz + DB）实现。

> 📌 提示：源码入口类为 `org.apache.rocketmq.broker.schedule.ScheduleMessageService`，建议结合日志与 JMX 指标进行线上问题排查。