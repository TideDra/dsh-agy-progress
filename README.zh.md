# @local/dsh-agy-progress

[English](./README.md) | 简体中文

专为 **Antigravity (`agy`) 模式**打造的进展播报增强插件：基于 60 条原版 Codex (`gpt-6`) 与 30 条原版 Agy (`gemini-4`) 真实轨迹标定的**两阶段节奏策略**，通过原生 `<SYSTEM_MESSAGE>` 信封轻推 Gemini 边干活边汇报简短进展，获得与 GPT-6 一致的实时透明协作体验。

---

## 基于 90 条真实轨迹标定的两阶段节奏策略

由于 Agy 中的 Gemini 单步工具调用极快（中位数仅 `6.0s`/步，但自然途中播报率仅 `0.47%`），单纯按固定小步数触发会导致短短十几秒内频繁刷屏。本插件采用对齐 GPT-6（开场必报 + 途中中位数 `65s` 一报）的**两阶段动态策略**：

1. **阶段 1：开场快速反馈**（当前用户请求尚未产生过任何可见回复时）：
   - 连续静默 **`>= 2` 步** 且距提问已过 **`>= 10 秒`** 时触发；
   - 10 秒内秒答的简单小问题零打扰；进入真正多步任务后中位数约 **`14s`** 即发出第一条勘察结论与行动计划汇报。
2. **阶段 2：途中稳健播报**（本轮已汇报过至少 1 次后）：
   - **时间主导**：距上次可见回复 **`>= 65 秒`**（且期间至少静默调了 `2` 步工具）；
   - **步数兜底**：连续静默 **`>= 10 步`** 且距上次可见回复 **`>= 45 秒`**；
   - 在 30 条真实 Agy 长任务轨迹上回放的中位播报间隔为 **`73 秒`（`6` 步）**，500 秒长任务中位数仅播报 `6` 次，既透明又不啰嗦。
3. **双重防刷屏冷却（Cooldown）**：
   - 若某次催促后模型仍未说话，需同时满足 **`>= 4` 步 且 `>= 30 秒`** 后才再次轻推。

---

## 核心工程保障

- **只作用于 `Antigravity` (`agy`) 主会话**：自动跳过 `Standard`/`Creator`/`Codex` 及所有 `invoke_subagent`/`run_swarm` 后台子会话；输入框左下角 **`💬 进展播报`** 开关与 `/agy-progress [on|off|status]` 命令仅在 `Antigravity` 会话中显示。
- **零提前停机**：强制要求在**发起下一轮工具调用的同一条回复**中顺带输出 1～2 句正文，严禁停止调工具或误调 `ask_user` / `send_message`。
- **100% 保护思考签名缓存（`FG-02` 安全）**：采用标准 `The following is a <SYSTEM_MESSAGE> not actually sent by the user...` 信封与 `source: { kind: 'agy-progress', form: 'notice', summary }`，完整保留 `reasoning_opaque` 与 `thought_signature` 缓存，并在 Web 聊天流中折叠为单行上下文提示。

---

## 安装与使用

需配合已安装 [`dsh-agy-mode`](https://github.com/TideDra/dsh-agy-mode)（`preset-agy`）的 DeepSeek Harness `web` Profile 使用：

```bash
git clone https://github.com/TideDra/dsh-agy-progress.git
dsh plugin --profile web add /path/to/dsh-agy-progress
```

安装完成后：
1. 在 DSH Web 界面进入任意 **`Antigravity`**（`agy`）会话（含通过 [`dsh-auto-mode`](https://github.com/TideDra/dsh-auto-mode) 自动路由过去的 Gemini 会话）；
2. 输入框左下角工具栏会显示默认点亮的 **`💬 进展播报`** 胶囊开关，点击即可随时开启或关闭（也可输入 `/agy-progress [on|off|status]` 查看当前阶段与静默步数计数）。

---

## 测试验证

```bash
npm test
```

## 开源协议

[MIT](./LICENSE)
