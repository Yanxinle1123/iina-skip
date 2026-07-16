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
