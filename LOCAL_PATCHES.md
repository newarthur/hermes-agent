# Hermes 本地 Patch 清单

> 维护者: NEWARTHUR
> 最后更新: 2026-06-13
> 关联技能: hermes-safe-update-with-local-patches

## 概述

本仓库在 NousResearch/hermes-agent 上游基础上维护 6 个功能级本地 patch。由于上游近期重构与本地功能存在重叠 hunks，当前恢复入口改为一个由 `git diff upstream/main..HEAD` 生成的 canonical overlay：`00-current-local-overlay.patch`。旧的功能级 patch 继续保留作审计/定位参考，但不再要求它们能在任意新版 upstream 上独立顺序应用。

核心保留策略：

1. 保留 Kimi Coding Plan 核心修复，避免 `api.kimi.com/coding/v1` 被回退到 legacy Moonshot，避免 Anthropic SDK 请求 `/coding/v1/v1/messages` 导致 auxiliary/title generation HTTP 404；同时保留 Kimi reasoning/content padding，避免跨 Provider 降级到 Kimi 时历史 tool-call 消息触发 HTTP 400。
2. 保留 Gemini CLI / CloudCode 兼容修复，包括 `cloudcode-pa://`、Gemini CLI OAuth credential 格式、stream chunk delta 属性，以及 Code Assist tool-use/functionResponse 历史组织。
3. 保留 persona model routes：CLI/Gateway 切换 personality 时同步切换 provider/model/fallback，并兼容 `agent.persona_model_routes` 与历史顶层 `persona_model_routes`。
4. 保留 Telegram model picker 旧消息清理，避免 inline keyboard 堆积。
5. 保留 Kimi fallback 修复：fallback provider/base_url 指向 Kimi Coding 时必须走 `anthropic_messages`，并保留 run_agent API message rebuild 路径，避免上游重构覆盖本地兼容逻辑。
6. 保留 Gemini CLI auxiliary compression 路由：`google-gemini-cli` 辅助压缩通过 CloudCode 客户端调用，避免走不兼容的 OpenAI/Anthropic 路径。

补充：provider picker 去重、本机 `openai-codex` 策略已合并进 `01-kimi-coding-plan-runtime.patch`，不再单独维护 `03-provider-picker-dedup-and-local-policy.patch`。

统一主目录：

```text
/root/.hermes/hermes-agent-patches/
├── by-feature/
│   ├── 00-current-local-overlay.patch     # 当前唯一恢复入口；由 upstream/main..HEAD 生成
│   ├── 01-kimi-coding-plan-runtime.patch  # 历史/审计参考
│   ├── 02-gemini-cli-cloudcode-compat.patch
│   ├── 03-persona-model-routing.patch
│   ├── 04-telegram-model-picker-cleanup.patch
│   ├── 05-kimi-fallback-fix.patch
│   └── 06-gemini-cli-auxiliary-compression.patch
├── by-file/                               # 历史参考；不再作为主恢复入口
└── restore-local-patches.sh                # 当前恢复脚本，应用 00 overlay 并执行验证
```

重要：以后恢复以 `by-feature/00-current-local-overlay.patch` 为准。其余 `by-feature/` 与 `by-file/` patch 仅保留作历史 diff/debug 参考，不要再把它们当主恢复清单。

---

## Patch 文件清单（canonical overlay + 6 个功能级参考 patch）

### 1. `01-kimi-coding-plan-runtime.patch`

| 属性 | 值 |
|------|-----|
| 文件位置 | `/root/.hermes/hermes-agent-patches/by-feature/01-kimi-coding-plan-runtime.patch` |
| 优先级 | critical |
| 修改类型 | Kimi Coding Plan endpoint、api_mode、runtime、Anthropic SDK URL 归一化、Kimi tool-call reasoning/content padding |
| 上游冲突 | 上游可能恢复 Moonshot endpoint 或缺少 Kimi Coding 双端点处理 |
| 保留理由 | 防止 Kimi Coding 路由回退、stale `chat_completions` 覆盖、`/coding/v1/v1/messages` 404，以及跨 Provider 降级到 Kimi 时 tool-call 历史消息 HTTP 400 |

包含文件：

- `hermes_cli/auth.py`
- `hermes_cli/model_switch.py` 中 Kimi `/v1` 剥离逻辑
- `hermes_cli/runtime_provider.py`
- `hermes_cli/models.py`（添加 `kimi-k2.7-highspeed` 到 TUI 模型列表）
- `agent/anthropic_adapter.py`
- `tests/hermes_cli/test_timeouts.py`
- `tests/hermes_cli/test_api_key_providers.py`
- `tests/hermes_cli/test_user_providers_model_switch.py`
- `agent/models_dev.py`

关键行为：

```python
# Hermes config / health check 可保留 /coding/v1
inference_base_url = "https://api.kimi.com/coding/v1"

# 但 Anthropic SDK 调用前必须改为 /coding，避免 SDK 再追加 /v1/messages
if normalized_base_url.rstrip("/").lower() == "https://api.kimi.com/coding/v1":
    normalized_base_url = "https://api.kimi.com/coding"
```

验证点：

- `kimi-coding` 使用 `https://api.kimi.com/coding/v1` 作为配置/模型列表端点。
- `anthropic_messages` 路径传入 Anthropic SDK 前使用 `https://api.kimi.com/coding`。
- stale `chat_completions` 不会覆盖 Kimi Coding 的 URL 检测结果。
- `tests/hermes_cli/test_timeouts.py::test_anthropic_adapter_normalizes_kimi_coding_v1_for_messages_sdk` 通过。
- Kimi 家族 endpoint 上，包含工具调用的 assistant 历史消息缺少 reasoning 内容时会补空字符串，避免 Kimi 400。
- TUI `/model` 菜单显示 `kimi-k2.7-code` 和 `kimi-k2.7-highspeed`（通过 `hermes_cli/models.py` 的 `_PROVIDER_MODELS["kimi-coding"]` 列表）。

---

### 2. `02-gemini-cli-cloudcode-compat.patch`

| 属性 | 值 |
|------|-----|
| 文件位置 | `/root/.hermes/hermes-agent-patches/by-feature/02-gemini-cli-cloudcode-compat.patch` |
| 优先级 | critical（继续使用 Gemini CLI 时） |
| 修改类型 | Gemini CLI endpoint/OAuth/CloudCode stream 兼容、Code Assist tool-use/functionResponse 历史组织 |
| 上游冲突 | 上游可能使用 Hermes 自有 Google OAuth 格式，不兼容 Gemini CLI credential 文件 |
| 保留理由 | 用户偏好交互式 OAuth/PKCE；需要 Hermes 与 Gemini CLI credential 互操作；Gemini Code Assist 要求 functionResponse parts 与前一轮 functionCall parts 一一匹配 |

包含文件：

- `agent/model_metadata.py`
- `agent/gemini_cloudcode_adapter.py`
- `agent/google_oauth.py`
- `hermes_cli/models.py`
- `tests/agent/test_gemini_cloudcode.py`

关键行为：

```python
# cloudcode-pa://google -> https://cloudcode-pa.googleapis.com
if normalized.startswith("cloudcode-pa://"):
    normalized = normalized.replace("cloudcode-pa://", "https://", 1)
    if normalized == "https://google":
        normalized = "https://cloudcode-pa.googleapis.com"
```

```python
# 使用 Gemini CLI credential 路径
Path.home() / ".gemini" / "oauth_creds.json"

# 同时支持 Gemini CLI 格式与旧 Hermes 格式
access_token = data.get("access_token") or data.get("access")
refresh_token = data.get("refresh_token") or RefreshParts.parse(...).refresh_token
expires_ms = data.get("expiry_date") or data.get("expires")
```

验证点：

- `cloudcode-pa://google` 能被识别为 Gemini provider。
- `~/.gemini/oauth_creds.json` 可被 Hermes 读取。
- CloudCode stream delta 带 `content` 和 `tool_calls` 属性。
- 连续 tool-role 消息会合并为一个 Gemini user turn，functionResponse parts 数量匹配前一轮 functionCall parts。

---

### 3. `03-persona-model-routing.patch`

| 属性 | 值 |
|------|-----|
| 文件位置 | `/root/.hermes/hermes-agent-patches/by-feature/03-persona-model-routing.patch` |
| 优先级 | critical（多人格路由依赖） |
| 修改类型 | personality 切换时应用 provider/model/fallback route；Gateway 启动 agent 时按当前 personality 解析 runtime |
| 上游冲突 | 上游可能只保存 `agent.system_prompt`，不按 personality 同步切换 provider/model/fallback |
| 保留理由 | Hermes 主 bot 依赖 hermes_main/hermes_osahs/hermes_ops 三人格路由；不同人格需要稳定使用各自配置的模型与 fallback |

包含文件：

- `cli.py`
- `gateway/run.py`
- `tests/cli/test_personality_none.py`

关键行为：

```python
# 同时兼容 documented agent.persona_model_routes 和历史顶层 persona_model_routes
routes = agent_cfg.get("persona_model_routes")
if not isinstance(routes, dict) or not routes:
    routes = cfg.get("persona_model_routes")
```

```python
# /personality 切换时同步 provider/model/fallback，并保存 display.personality
save_config_value("display.personality", personality_name)
```

验证点：

- CLI 启动时能按 `display.personality` 应用 persona route。
- CLI `/personality none` 会持久化清空 `display.personality`。
- Gateway 没有 session `/model` override 时优先使用当前 personality 的 route。
- `tests/cli/test_personality_none.py` 通过。


---

### 4. `04-telegram-model-picker-cleanup.patch`

| 属性 | 值 |
|------|-----|
| 文件位置 | `/root/.hermes/hermes-agent-patches/by-feature/04-telegram-model-picker-cleanup.patch` |
| 优先级 | normal |
| 修改类型 | Telegram model picker 消息清理 |
| 上游冲突 | 上游可能没有旧 picker 消息删除逻辑 |
| 保留理由 | 防止重复发送 model picker 消息，避免 inline keyboard 堆积 |

包含文件：

- `gateway/platforms/telegram.py`

关键行为：

```python
old_state = self._model_picker_state.pop(str(chat_id), None)
if old_state and old_state.get("msg_id"):
    await self._bot.delete_message(chat_id=int(chat_id), message_id=old_state["msg_id"])
```

验证点：

- Telegram 打开新的 model picker 前，会尝试删除同 chat 的旧 picker message。
- 删除失败时静默忽略，不影响新 picker 发送。


---

### 5. `05-kimi-fallback-fix.patch`

| 属性 | 值 |
|------|-----|
| 文件位置 | `/root/.hermes/hermes-agent-patches/by-feature/05-kimi-fallback-fix.patch` |
| 优先级 | critical（Kimi fallback 依赖） |
| 修改类型 | fallback api_mode 推断、run_agent API message rebuild 兼容 |
| 上游冲突 | 上游可能仅按 `anthropic` provider 或 `/anthropic` base_url 判断 fallback，不识别 `kimi-coding` / `/coding`；上游重构 run_agent message rebuild 时可能覆盖本地 sanitization 顺序 |
| 保留理由 | 避免 fallback 到 Kimi Coding 时错误走 `chat_completions`，并确保 API-call-time message rebuild 继续保留 Hermes 本地的 reasoning/tool-call sanitization 兼容路径 |

包含文件：

- `run_agent.py`

关键行为：

```python
elif (
    fb_provider == "anthropic"
    or fb_provider == "kimi-coding"
    or fb_base_url.rstrip("/").lower().endswith("/anthropic")
    or "/coding" in fb_base_url.lower()
):
    fb_api_mode = "anthropic_messages"
```

验证点：

- fallback provider 为 `kimi-coding` 时 api_mode 是 `anthropic_messages`。
- fallback base_url 包含 `/coding` 时 api_mode 是 `anthropic_messages`。
- `git apply --reverse --check /root/.hermes/hermes-agent-patches/by-feature/05-kimi-fallback-fix.patch` 通过。

---

### 6. `06-gemini-cli-auxiliary-compression.patch`

| 属性 | 值 |
|------|-----|
| 文件位置 | `/root/.hermes/hermes-agent-patches/by-feature/06-gemini-cli-auxiliary-compression.patch` |
| 优先级 | critical（auxiliary.compression 依赖 Google Gemini CLI OAuth 时） |
| 修改类型 | 让 `agent.auxiliary_client.resolve_provider_client()` 识别 `google-gemini-cli`，并路由到 `GeminiCloudCodeClient` |
| 上游冲突 | 上游 auxiliary resolver 可能只支持 OpenAI-compatible / native Gemini API-key 路径，不识别 Gemini CLI 的 `cloudcode-pa://google` OAuth runtime |
| 保留理由 | 用户偏好 Gemini CLI 交互式 OAuth/PKCE；`auxiliary.compression` 当前使用 `provider: google-gemini-cli`，需要避免错误回退到 OpenAI client 或缺失 credential |

包含文件：

- `agent/auxiliary_client.py`
- `tests/hermes_cli/test_gemini_provider.py`

关键行为：

```python
if provider == "google-gemini-cli":
    from hermes_cli.auth import resolve_gemini_oauth_runtime_credentials
    from agent.gemini_cloudcode_adapter import GeminiCloudCodeClient

    runtime = resolve_gemini_oauth_runtime_credentials()
    return GeminiCloudCodeClient(
        api_key=runtime.get("api_key", "google-oauth"),
        base_url=runtime.get("base_url") or "cloudcode-pa://google",
        project_id=runtime.get("project_id"),
    ), model
```

验证点：

- `resolve_provider_client("google-gemini-cli", model="gemini-3-flash-preview")` 返回 `GeminiCloudCodeClient`。
- `call_llm(task="compression")` 能按 `~/.hermes/config.yaml` 的 `auxiliary.compression` 路由到 `google-gemini-cli`。
- 重启 `hermes-gateway.service` 后日志无新的 auxiliary/compression 报错。

---

## 旧 8 项文件级补丁映射

| 旧文件级补丁 | 新功能级 patch |
|--------------|----------------|
| `by-file/agent_model_metadata.py.patch` | `02-gemini-cli-cloudcode-compat.patch` |
| `gemini-all-fixes.patch` | `02-gemini-cli-cloudcode-compat.patch` |
| `by-file/hermes_cli_auth.py.patch` | `01-kimi-coding-plan-runtime.patch` |
| `by-file/hermes_cli_runtime_provider.py.patch` | `01-kimi-coding-plan-runtime.patch` |
| `by-file/agent_anthropic_adapter.py.patch` | `01-kimi-coding-plan-runtime.patch` |
| `by-file/tests_hermes_cli_test_timeouts_kimi_anthropic_base_url.patch` | `01-kimi-coding-plan-runtime.patch` |
| `by-file/agent_models_dev.py.patch` | `01-kimi-coding-plan-runtime.patch`（provider local policy 已并入 01） |
| `by-file/hermes_cli_model_switch.py.patch` | `01-kimi-coding-plan-runtime.patch` |
| `by-file/tests_hermes_cli_test_user_providers_model_switch_test-fix.patch` | `01-kimi-coding-plan-runtime.patch` |
| `by-file/gateway_platforms_telegram.py.patch` | `04-telegram-model-picker-cleanup.patch` |

---

## 上游 sync 后恢复流程

### 自动恢复脚本

脚本位置：

```bash
/root/.hermes/hermes-agent-patches/restore-local-patches.sh
```

执行方式：

```bash
cd /root/.hermes/hermes-agent
/root/.hermes/hermes-agent-patches/restore-local-patches.sh
```

脚本会按顺序应用：

1. `01-kimi-coding-plan-runtime.patch`
2. `02-gemini-cli-cloudcode-compat.patch`
3. `03-persona-model-routing.patch`
4. `04-telegram-model-picker-cleanup.patch`
5. `05-kimi-fallback-fix.patch`

然后执行：

```bash
python3 -m py_compile \
  cli.py gateway/run.py \
  agent/model_metadata.py agent/models_dev.py agent/anthropic_adapter.py \
  agent/gemini_cloudcode_adapter.py agent/google_oauth.py \
  hermes_cli/auth.py hermes_cli/model_switch.py hermes_cli/models.py \
  hermes_cli/runtime_provider.py \
  gateway/platforms/telegram.py \
  run_agent.py

PYTEST_ADDOPTS='' .venv/bin/python -m pytest -o addopts='' \
  tests/cli/test_personality_none.py \
  tests/hermes_cli/test_user_providers_model_switch.py \
  tests/hermes_cli/test_models.py \
  tests/hermes_cli/test_timeouts.py \
  tests/agent/test_gemini_cloudcode.py -q
```

### 手动恢复步骤

1. 先用 `hermes-safe-update-with-local-patches` 完成 upstream sync / merge / backup。
2. 确认工作树无冲突标记。
3. 应用 `/root/.hermes/hermes-agent-patches/by-feature/` 下 5 个 patch。
4. 运行语法检查和 targeted tests。
5. 检查 picker 行为：`kimi-coding` 保留，`openai-codex` 保留，普通 `openai` 不作为独立 provider 显示。
6. Review diff 后再提交。

---

## 当前验证命令

```bash
git apply --reverse --check /root/.hermes/hermes-agent-patches/by-feature/01-kimi-coding-plan-runtime.patch
git apply --reverse --check /root/.hermes/hermes-agent-patches/by-feature/02-gemini-cli-cloudcode-compat.patch
git apply --reverse --check /root/.hermes/hermes-agent-patches/by-feature/03-persona-model-routing.patch
git apply --reverse --check /root/.hermes/hermes-agent-patches/by-feature/04-telegram-model-picker-cleanup.patch
git apply --reverse --check /root/.hermes/hermes-agent-patches/by-feature/05-kimi-fallback-fix.patch

python3 -m py_compile \
  cli.py gateway/run.py \
  agent/model_metadata.py agent/models_dev.py agent/anthropic_adapter.py \
  agent/gemini_cloudcode_adapter.py agent/google_oauth.py \
  hermes_cli/auth.py hermes_cli/model_switch.py hermes_cli/models.py \
  hermes_cli/runtime_provider.py \
  gateway/platforms/telegram.py \
  run_agent.py

PYTEST_ADDOPTS='' .venv/bin/python -m pytest -o addopts='' \
  tests/cli/test_personality_none.py \
  tests/hermes_cli/test_user_providers_model_switch.py \
  tests/hermes_cli/test_models.py \
  tests/hermes_cli/test_timeouts.py \
  tests/agent/test_gemini_cloudcode.py -q
```

---

## 版本历史

| 日期 | 说明 |
|------|------|
| 2026-04-29 | 首次整理并文档化本地 patch |
| 2026-04-30 | 新增 `gemini-all-fixes.patch` 为正式恢复项 |
| 2026-04-30 | 新增 Kimi Coding Anthropic SDK URL 归一化，修复 title generation 404 |
| 2026-04-30 | 从 8 个文件级 patch 精简为 4 个功能级 patch；保留 Kimi/Gemini 核心修复和 openai-codex-only picker 策略 |
| 2026-04-30 | 将 `05-kimi-reasoning-content-padding.patch` 合并进 `01-kimi-coding-plan-runtime.patch`，将 Gemini Code Assist tool-use 补丁合并进 `02-gemini-cli-cloudcode-compat.patch` |
| 2026-05-07 | 将 `05-kimi-fallback-fix.patch` 补入正式 patch 清单，和 `restore-local-patches.sh` 保持一致 |

---

## 长期建议

1. 尽量上游化 provider alias 去重、重复 display name 处理、Telegram picker cleanup。
2. Kimi Coding 双端点逻辑需要独立回归测试长期保留。
3. 每次 upstream sync 后优先检查 `01-kimi-coding-plan-runtime.patch`，因为它直接影响 auxiliary/title generation 是否 404。
4. 不要重新引入独立 `openai` provider，除非用户明确改变本机策略。
