# automation 镜像

构建：`sh build/automation/build.sh registry.example.com/auto-test-automation:1.0.0`。

镜像同时提供 `/v1/planner/*` 与 `/v1/generator/*`，共用 Playwright、Claude CLI 和 `/var/lib/automation/exploration-experience.json` 中按需求 ID 保存的探索经验。将实际 `setting.json` 放到此目录（已忽略）后再构建；格式参考 `setting.example.json`。
