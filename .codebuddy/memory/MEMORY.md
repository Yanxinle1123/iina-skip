# IINA Skip 项目记忆

## 视频指纹检测性能优化

### GPU 硬件解码 (VideoToolbox) — 已移除
- 曾经尝试用 `-hwaccel videotoolbox` 加速解码
- **结论：在这个场景下 GPU 反而更慢**，已完全移除
- 原因：只需 2fps/9×8 灰度图，GPU→CPU 内存拷贝开销 + 初始化开销 > 解码加速收益
- GPU 硬解适合高帧率/高分辨率播放场景，不适合低带宽帧提取场景

### 磁盘缓存帧哈希
- 缓存目录：`/tmp/iina-skip-cache/`
- 缓存文件命名：`{文件路径MD5}_{算法指纹}.json`
- 算法指纹使用混合方式：`v1_{参数MD5前8位}` (手动版本号 + 自动参数哈希)
- 影响指纹的参数：ANALYZE_SECONDS, FRAME_FPS, FRAME_WIDTH, FRAME_HEIGHT
- 当算法参数改变时自动生成新指纹，旧缓存自然失效
- 同一视频文件的 intro/outro 区域存在同一个缓存文件中
- 首次提取 → 保存缓存；后续直接读取 → 近乎零等待

### 性能预期
- 首次运行：GPU 硬解将 60s → ~5-8s
- 第二次及以后：缓存命中 → ~0.1s
- 预计算切换集会进一步加速相邻集检测

### 清除识别缓存 UI 功能
- 在偏好设置页面 (`preferences.html`) 添加了"缓存管理"区域
- 包含"清除识别缓存"按钮，点击后通过 sentinel 偏好项触发清除
- 通信机制：preferences.html 设置 `clear_video_cache_trigger` 偏好 → main.js 每 2 秒轮询检测变化 → 调用 `clearVideoMatchCache()`
- `clearVideoMatchCache()` 在 `detectors/video-match.js` 中实现：删除 `$TMPDIR/iina-skip-cache/` 目录 + 清空内存结果缓存
- sentinel 偏好项已添加到 `Info.json` 和 `preferences.html` 的 preferenceDefaults

## 重要 Bug 修复：自动跳过加载中 seek 崩溃 + 误拦截

### 症状（第一轮）
- 播放列表连播：上一集片尾自动跳过 → 切到下一集 → 下一集还在 starting 状态
- 插件立刻对未加载完的文件发出 `core.seekTo()` → mpv 返回 `-12 MPV_ERROR_LOADING_FAILED`
- IINA 的 `chkErr` 将其视为致命错误 → **进程直接退出**

### 症状（第二轮，修复后引入）
- 自动跳过完全失效，但手动点击跳过按钮正常

### 真正的根因
- 第一轮的修复里新增的 `isSeekable()` 把"未知状态"也当成不可跳转：
  `mpv.getNumber('seekable')` 在文件未就绪时返回 `undefined`，`=== 1` 为 false → 返回 false
  → 守卫 `if (!fileLoaded || !isSeekable())` **永久拦截**自动跳过
- 手动跳过走 `skipSection` 直接 seek，不经过该守卫，所以正常

### 最终修复（main.js）
1. `fileLoaded` 状态标志：`mpv.file-loaded` 置 true，`mpv.end-file` 置 false（防止 file-loaded 前的 seek）
2. `isSeekable()` 改为**放行语义**：仅当 `seekable` 明确为 0/false 才拦截，undefined/异常一律视为可跳转（返回 true）
3. 自动跳过分支守卫简化为只检查 `!fileLoaded`（加载完成前不 seek），移除会误拦截的 `isSeekable()` 守卫
4. `skipSection` 的 `core.seekTo()` 加 try/catch，失败时不崩溃，并 `scheduleSkipRetry` 每 300ms 重试（上限 20 次）
5. `skipSection` 返回布尔值；`updateOverlay` 据此显示 pending/complete 状态
6. `resetState`（文件切换）清理重试定时器与计数

### 关键教训
- **绝不能在文件未加载完成时调用 `core.seekTo()`**——IINA 对 mpv 错误是 fatal 级别的
- 守卫逻辑必须是"放行优先"：不确定时可跳转，绝不能把未知状态当不可跳转，否则会静默禁用功能
- seek 失败用 try/catch + 重试兜底，而不是一次性放弃
