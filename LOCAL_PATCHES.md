# Hermes 本地 Patch 清单

> 维护者: NEWARTHUR
> 最后更新: 2026-04-29
> 关联技能: hermes-safe-update-with-local-patches

## 概述

本仓库在 NousResearch/hermes-agent 上游基础上维护了以下本地 patch。这些 patch 主要服务于：

1. **Kimi Coding Plan 端点迁移** — 从 legacy Moonshot (`api.moonshot.ai/v1`) 迁移到 Kimi Coding Plan (`api.kimi.com/coding/v1`)
2. **Provider 去重与别名规范化** — 防止 model picker 中出现重复 provider 条目
3. **Telegram 交互优化** — 防止 model picker 消息累积
4. **Gemini CLI 支持** — 处理 `cloudcode-pa://` 协议

⚠️ **重要**: 这些 patch 与上游方向存在冲突（上游已撤销部分修改），每次 sync 后需要手动 re-apply。

---

## Patch 文件清单

### 1. `agent/model_metadata.py`

| 属性 | 值 |
|------|-----|
| **修改类型** | 添加 Gemini CLI 协议支持 |
| **上游冲突** | 🔴 上游已移除 `cloudcode-pa://` 处理 |
| **保留理由** | Gemini CLI 使用 `cloudcode-pa://` 协议，需要转换为 HTTPS |

**Patch 内容**:
```python
def _normalize_base_url(base_url: str) -> str:
    normalized = (base_url or "").strip().rstrip("/")
    # Handle Gemini CLI's custom protocol format
    if normalized.startswith("cloudcode-pa://"):
        normalized = normalized.replace("cloudcode-pa://", "https://", 1)
        if normalized == "https://google":
            normalized = "https://cloudcode-pa.googleapis.com"
    return normalized
```

**URL 映射**:
```python
_URL_TO_PROVIDER: Dict[str, str] = {
    # ... existing entries ...
    "cloudcode-pa.googleapis.com": "gemini",
}
```

---

### 2. `agent/models_dev.py`

| 属性 | 值 |
|------|-----|
| **修改类型** | 移除独立 `openai` provider，保留 `openai-codex` |
| **上游冲突** | 🔴 上游恢复了 `"openai": "openai"` |
| **保留理由** | 本地配置只使用 OAuth 认证的 `openai-codex`，不使用 API key 的 `openai` |

**Patch 内容**:
```python
PROVIDER_TO_MODELS_DEV: Dict[str, str] = {
    "openrouter": "openrouter",
    "anthropic": "anthropic",
    # REMOVED: "openai": "openai",  # ← 删除此行
    "openai-codex": "openai",       # ← 保留此行
    "zai": "zai",
    "kimi-coding": "kimi-for-coding",
    # ...
}
```

**关联影响**:
- `tests/hermes_cli/test_user_providers_model_switch.py` 需要适配（mock OAuth 认证状态）

---

### 3. `hermes_cli/auth.py`

| 属性 | 值 |
|------|-----|
| **修改类型** | Kimi provider 配置重写 + API key 解析增强 |
| **上游冲突** | 🔴 上游恢复为 Moonshot 配置 |
| **保留理由** | 使用 Kimi Coding Plan 端点，支持 `sk-kimi-*` 密钥 |

**Patch 内容**:

**ProviderConfig 修改**:
```python
"kimi-coding": ProviderConfig(
    id="kimi-coding",
    name="Kimi / Kimi Coding Plan",  # ← 从 "Kimi / Moonshot" 改名
    auth_type="api_key",
    # 使用 Kimi Coding Plan 端点
    inference_base_url="https://api.kimi.com/coding/v1",  # ← 从 api.moonshot.ai/v1 迁移
    api_key_env_vars=("KIMI_API_KEY", "KIMI_CODING_API_KEY"),
    base_url_env_var="KIMI_BASE_URL",
),
```

**KIMI_CODE_BASE_URL 修改**:
```python
# 使用 Coding/v1 端点（Anthropic Messages 兼容）
KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1"
```

**API key 解析增强**:
```python
# 优先使用环境变量，回退到 ~/.hermes/.env
val = os.getenv(env_var, "").strip()
if not val:
    try:
        from hermes_cli.config import get_env_value
        val = (get_env_value(env_var) or "").strip()
    except Exception:
        val = ""
```

---

### 4. `hermes_cli/model_switch.py`

| 属性 | 值 |
|------|-----|
| **修改类型** | Provider 别名去重 + Kimi 端点处理 + 重复名称显示优化 |
| **上游冲突** | 🔴 上游移除了这些修改 |
| **保留理由** | 防止 model picker 重复；Kimi 使用 Anthropic Messages 协议 |

**Patch 内容**:

**导入 `normalize_provider`**:
```python
from hermes_cli.providers import (
    # ... existing imports ...
    normalize_provider,  # ← 新增
    resolve_provider_full,
)
```

**Kimi 端点 /v1 剥离**:
```python
if (
    api_mode == "anthropic_messages"
    and target_provider in {"opencode-zen", "opencode-go", "kimi-coding"}  # ← 添加 "kimi-coding"
    and isinstance(base_url, str)
    and base_url
):
    base_url = re.sub(r"/v1/?$", "", base_url)
```

**Provider 去重（Section 3）**:
```python
for ep_name, ep_cfg in user_providers.items():
    if not isinstance(ep_cfg, dict):
        continue
    normalized_ep_name = normalize_provider(ep_name)  # ← 新增
    # Skip if this slug (or one of its aliases) was already emitted
    if ep_name.lower() in seen_slugs or normalized_ep_name in seen_mdev_ids:  # ← 新增条件
        continue
    # ...
    seen_mdev_ids.add(normalized_ep_name)  # ← 新增
```

**重复显示名称处理**:
```python
# Make duplicate display names explicit so messaging clients can distinguish
name_counts: dict[str, int] = {}
for row in results:
    name = str(row.get("name", "")).strip()
    if name:
        name_counts[name] = name_counts.get(name, 0) + 1

if any(count > 1 for count in name_counts.values()):
    for row in results:
        name = str(row.get("name", "")).strip()
        slug = str(row.get("slug", "")).strip()
        if name and slug and name_counts.get(name, 0) > 1 and slug != name:
            row["name"] = f"{name} ({slug})"
```

---

### 5. `hermes_cli/runtime_provider.py`

| 属性 | 值 |
|------|-----|
| **修改类型** | Kimi Coding api_mode 自动检测 + 端点处理 |
| **上游冲突** | 🔴 上游移除了这些修改 |
| **保留理由** | Kimi Coding 必须使用 Anthropic Messages，不能 fallback 到 chat_completions |

**Patch 内容**:

**`_resolve_runtime_from_pool_entry` 中的 api_mode 解析**:
```python
detected = _detect_api_mode_for_url(base_url)
if provider == "kimi-coding" and detected:
    # Kimi Coding's /coding endpoint only works through Anthropic Messages;
    # ignore stale chat_completions persisted by older switch flows.
    api_mode = detected
elif configured_mode and _provider_supports_explicit_api_mode(provider, configured_provider):
    api_mode = configured_mode
elif provider in ("opencode-zen", "opencode-go"):
    # ... existing opencode logic ...
    from hermes_cli.models import opencode_model_api_mode
    api_mode = opencode_model_api_mode(provider, effective_model)
elif detected:
    api_mode = detected
```

**`resolve_runtime_provider` 中的 Kimi 特殊处理**:
```python
if api_mode == "anthropic_messages" and provider in ("opencode-zen", "opencode-go", "kimi-coding"):
    # Kimi Coding's /coding/v1 endpoint must use Anthropic Messages.
    # Do URL detection before honoring a persisted api_mode so stale
    # chat_completions values written by older model-switch flows cannot
    # break Kimi after an upgrade.
    detected = _detect_api_mode_for_url(base_url)
    if provider == "kimi-coding" and detected:
        api_mode = detected
    elif configured_mode and _provider_supports_explicit_api_mode(provider, configured_provider):
        api_mode = configured_mode
    elif provider in ("opencode-zen", "opencode-go"):
        from hermes_cli.models import opencode_model_api_mode
        api_mode = opencode_model_api_mode(provider, effective_model)
    elif detected:
        api_mode = detected
```

---

### 6. `gateway/platforms/telegram.py`

| 属性 | 值 |
|------|-----|
| **修改类型** | Model picker 消息防累积 |
| **上游冲突** | 🔴 上游删除了此逻辑 |
| **保留理由** | 防止重复发送 model picker 消息，避免 inline keyboard 累积 |

**Patch 内容**:
```python
try:
    # If there's an existing picker message for this chat, delete it first
    # so we don't accumulate stale inline-keyboard messages.
    old_state = self._model_picker_state.pop(str(chat_id), None)
    if old_state and old_state.get("msg_id"):
        try:
            await self._bot.delete_message(
                chat_id=int(chat_id),
                message_id=old_state["msg_id"],
            )
        except Exception:
            pass  # Message may already be deleted or too old

    # Build provider buttons — 2 per row
    buttons: list = []
    for p in providers:
        # ... existing logic ...
```

---

## 测试适配

### 需要修改的测试文件

| 文件 | 修改原因 |
|------|---------|
| `tests/hermes_cli/test_user_providers_model_switch.py` | `openai` provider 改为 `openai-codex` (OAuth) |

### 测试修改示例

```python
# BEFORE (上游期望)
def test_list_authenticated_providers_openai_built_in_nonzero_total(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    providers = list_authenticated_providers()
    openai = next(p for p in providers if p.slug == "openai")
    assert openai.total_models > 0
    assert openai.source == "built-in"

# AFTER (适配 openai-codex OAuth)
def test_list_authenticated_providers_openai_built_in_nonzero_total(monkeypatch):
    from hermes_cli.providers import HermesOverlay, HERMES_OVERLAYS
    import agent.credential_pool
    
    monkeypatch.setitem(
        HERMES_OVERLAYS, "openai-codex",
        HermesOverlay(auth_type="oauth_external")
    )
    monkeypatch.setattr(
        agent.credential_pool, "load_pool",
        lambda: type("Pool", (), {"has_credentials": lambda self: True})()
    )
    providers = list_authenticated_providers()
    openai_codex = next(p for p in providers if p.slug == "openai-codex")
    assert openai_codex.total_models > 0
    assert openai_codex.source == "hermes"
```

---

## 上游 Sync 后恢复流程

### 与 `hermes-safe-update-with-local-patches` Skill 的协作

**Skill 负责**：安全地同步上游、创建备份、处理合并冲突  
**本文档负责**：在 skill 完成后，指导如何重新应用本地 patch

**执行顺序**：
1. 先执行 `hermes-safe-update-with-local-patches` skill 完成上游同步
2. 然后参考本文档的 "Patch 内容" 部分手动恢复各文件
3. 最后修复测试并提交

### 自动恢复脚本

```bash
#!/bin/bash
# restore-local-patches.sh
# 在上游 sync 后执行（skill 完成后）

cd ~/.hermes/hermes-agent

echo "=== 恢复本地 Patch ==="

# 1. 检查是否有冲突标记
if grep -r "<<<<<<< HEAD" agent/ hermes_cli/ gateway/ 2>/dev/null; then
    echo "ERROR: 存在未解决的冲突标记"
    exit 1
fi

# 2. 应用各文件的 patch
# agent/model_metadata.py - Gemini CLI
git show 117a26936 -- agent/model_metadata.py | git apply -

# agent/models_dev.py - 移除 openai
git show 117a26936 -- agent/models_dev.py | git apply -

# hermes_cli/auth.py - Kimi Coding Plan
git show 117a26936 -- hermes_cli/auth.py | git apply -

# hermes_cli/model_switch.py - 去重 + Kimi
git show 117a26936 -- hermes_cli/model_switch.py | git apply -

# hermes_cli/runtime_provider.py - api_mode 检测
git show 117a26936 -- hermes_cli/runtime_provider.py | git apply -

# gateway/platforms/telegram.py - picker 清理
git show 117a26936 -- gateway/platforms/telegram.py | git apply -

# 3. 修复测试
# tests/hermes_cli/test_user_providers_model_switch.py
git show 74e6528d3 -- tests/hermes_cli/test_user_providers_model_switch.py | git apply -

echo "=== 验证 ==="
python -m pytest tests/hermes_cli/test_user_providers_model_switch.py tests/hermes_cli/test_models.py -q

echo "=== 提交 ==="
git add -A
git commit -m "restore: re-apply high-value local patches after upstream sync ($(date +%Y-%m-%d))"
```

### 手动恢复步骤

1. **执行 skill 完成上游同步**
   - 运行 `hermes-safe-update-with-local-patches` skill
   - 解决合并冲突（保留上游的兼容性修复）
   - 确认 `main` 已对齐 `upstream/main`

2. **应用 patch**（参考本文档 "Patch 内容" 部分）
   - 逐文件检查并应用修改
   - 不要直接 cherry-pick 整个文件（可能覆盖上游修复）
   - 优先使用 `git cherry-pick --no-commit <patch-commit>`

3. **修复测试**
   - 运行 `pytest tests/hermes_cli/test_user_providers_model_switch.py`
   - 根据失败信息更新测试期望（参考 "测试适配" 部分）

4. **验证**
   - `hermes model` 正确显示 provider 列表
   - `kimi-coding` 和 `openai-codex` 正常显示
   - 无重复 provider 条目

5. **提交**
   ```bash
   git add -A
   git commit -m "restore: re-apply high-value local patches after upstream sync (YYYY-MM-DD)"
   ```

---

## 版本历史

| 日期 | Commit | 说明 |
|------|--------|------|
| 2026-04-29 | `117a269` | 首次整理并文档化本地 patch |
| 2026-04-29 | `74e6528` | 适配测试：openai → openai-codex OAuth |

---

## 长期建议

1. **考虑上游化**: 以下 patch 可以考虑提交 PR 到 NousResearch：
   - Provider 别名去重 (`normalize_provider`)
   - Telegram picker 消息清理
   - 重复显示名称处理

2. **保持文档更新**: 每次 sync 后更新此文档，记录新的冲突模式

3. **自动化**: 考虑使用 `git notes` 或 `git config` 存储 patch 元数据
