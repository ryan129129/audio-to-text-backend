# Segments 合并规则

本文档描述了 Supadata 返回的细粒度 segments 合并为完整句子的规则。

## 背景

Supadata AI 生成的转录返回逐词/逐短语级别的 chunks，例如：

```json
{"text": "Hello", "start": 0, "end": 1.5},
{"text": "大家好,", "start": 0.3, "end": 1.8},
{"text": "我是 老", "start": 0.56, "end": 2.06},
{"text": "高 咱", "start": 0.76, "end": 2.26},
{"text": "们 今天", "start": 0.98, "end": 2.48},
{"text": "来 讲", "start": 1.28, "end": 2.78}
```

需要合并为：

```json
{"text": "Hello大家好,我是老高咱们今天来讲", "start": 0, "end": 2.78}
```

## 相关代码

`src/providers/supadata/supadata.service.ts` 中的 `mergeSegments` 方法

---

## 断句规则

以下任一条件满足时，会断开当前 segment，开始新的 segment：

| 规则 | 参数 | 默认值 | 说明 |
|------|------|--------|------|
| 时间间隔过大 | `maxGapSeconds` | 1.5 秒 | 两个 segment 之间的间隔超过阈值 |
| 句末标点 | - | - | 当前 segment 以 `。！？.!?` 结尾 |
| 不同说话人 | - | - | speaker 字段不同时不合并 |
| 超过最大长度 | `maxLengthChars` | 200 字符 | 合并后的文本超过最大长度 |

### 参数调整

如需调整参数，修改 `mergeSegments` 调用：

```typescript
const segments = this.mergeSegments(rawSegments, {
  maxGapSeconds: 2.0,      // 放宽时间间隔
  maxLengthChars: 300,     // 允许更长的句子
});
```

---

## 空格处理规则

### 拼接时的空格

| 左边结尾 | 右边开头 | 处理 | 示例 |
|----------|----------|------|------|
| 英文/数字 | 英文/数字 | 添加空格 | `Hello` + `world` → `Hello world` |
| 中文 | 中文 | 不加空格 | `大家好` + `我是` → `大家好我是` |
| 中文 | 英文 | 不加空格 | `你好` + `Claude` → `你好Claude` |
| 英文 | 中文 | 不加空格 | `Hello` + `大家好` → `Hello大家好` |
| 标点 | 任意 | 不加空格 | `你好,` + `我是` → `你好,我是` |

### 清理原始文本中的空格

Supadata 返回的原始文本可能包含中文字符之间的异常空格（如 `我是 老`），会在合并完成后统一清理：

| 原始文本 | 清理后 |
|----------|--------|
| `我是 老高` | `我是老高` |
| `咱 们 今天` | `咱们今天` |
| `Hello world` | `Hello world`（保留，英文之间） |
| `你好 Claude` | `你好 Claude`（保留，中英之间） |

**清理规则**：仅移除 **中文字符之间** 的空格，保留英文单词之间的空格。

匹配的中文字符范围：
- 汉字：`\u4e00-\u9fa5`
- 中文标点：`，。！？、：；""''（）【】`

---

## 示例

### 输入

```json
[
  {"text": "Hello", "start": 0, "end": 1.5, "speaker": null},
  {"text": "大家好,", "start": 0.3, "end": 1.8, "speaker": null},
  {"text": "我是 老", "start": 0.56, "end": 2.06, "speaker": null},
  {"text": "高 咱", "start": 0.76, "end": 2.26, "speaker": null},
  {"text": "们 今天", "start": 0.98, "end": 2.48, "speaker": null},
  {"text": "来 讲", "start": 1.28, "end": 2.78, "speaker": null},
  {"text": "一个话题。", "start": 2.8, "end": 4.0, "speaker": null},
  {"text": "那就是", "start": 4.5, "end": 5.5, "speaker": null}
]
```

### 输出

```json
[
  {"text": "Hello大家好,我是老高咱们今天来讲一个话题。", "start": 0, "end": 4.0, "speaker": null},
  {"text": "那就是", "start": 4.5, "end": 5.5, "speaker": null}
]
```

**解释**：
1. 前 7 个 segments 合并为一个（时间连续，无句末标点直到 `话题。`）
2. `一个话题。` 以句号结尾，触发断句
3. `那就是` 开始新的 segment
4. 中文之间的空格被清理（`我是 老` → `我是老`）

---

## 待优化项

- [ ] 考虑逗号 `,` `，` 是否也应该断句
- [ ] 中英文之间是否需要添加空格（如 `你好 Claude` vs `你好Claude`）
- [ ] 支持更多语言的标点符号（日文、韩文等）
- [ ] 根据语言自动调整合并策略

---

## 更新日志

- **2025-12-24**：
  - 初始版本
  - 实现基于时间间隔、标点、speaker、长度的断句规则
  - 实现智能空格处理（英文加空格，中文不加）
  - 实现中文字符间空格清理
