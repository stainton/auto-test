# 浏览器基础镜像

planner、generator、executor、automation 四个镜像都要 Chromium。浏览器（几百 MB）只在这个基础镜像里下载一次：

- 各服务的 `build.sh` 会先执行 `build/base/build.sh`，它按 `build/planner/package.json` 里固定的 `@playwright/test` 版本构建 `auto-test-browser-base:<版本>`；本地已有同版本镜像时直接复用，不会重新下载。
- 服务镜像只做 `npm ci`，所以升级 `@anthropic-ai/claude-code` 等依赖不再重下浏览器；升级 Playwright 版本（三份 `package.json` 须同步）才会重建基础镜像。
- 服务镜像构建时会校验已安装的 Playwright 所需的 Chromium 确实在基础镜像里，版本没同步会在构建阶段失败，而不是运行时才发现。
- 用 CI 或多台机器构建时，把基础镜像推到镜像仓库并设置 `BROWSER_BASE_IMAGE=<registry>/auto-test-browser-base`，各机器先 `docker pull <registry>/auto-test-browser-base:<版本>`，`build.sh` 发现本地已有该标签就不再构建，从而跳过下载。
