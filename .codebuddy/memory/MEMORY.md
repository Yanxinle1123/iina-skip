# IINA Skip 项目记忆

## 视频指纹检测性能优化

### GPU 硬件解码 (VideoToolbox)
- 在 `extractFramesRaw` 中添加了 `-hwaccel videotoolbox` 参数
- **重要**：先调用 `checkHwaccelSupport(ffmpegPath)` 检测 ffmpeg 是否支持 videotoolbox（通过 `ffmpeg -hwaccels` 命令），结果缓存
- 只在确认支持时才用 GPU，否则直接 CPU 软解，避免"先 GPU 失败再 CPU 重试"的双次解码
- `extractFrames` 逻辑：检测支持 → 尝试 GPU → 单文件失败时回退 CPU
- M1 芯片上解码 1080p 视频可从 ~30fps 提升至 >200fps
- 注意：对于 2fps/9×8 灰度图的低带宽场景，GPU 内存拷贝开销可能抵消解码加速

### 并发限制
- `MAX_CONCURRENT_EXTRACTIONS = 4`，避免 10 路 ffmpeg 同时跑互相抢 CPU
- 通过 `runWithConcurrencyLimit()` 队列实现

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
