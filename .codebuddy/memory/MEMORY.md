# IINA Skip 项目记忆

## 视频指纹检测性能优化

### GPU 硬件解码 (VideoToolbox)
- 在 `extractFramesRaw` 中添加了 `-hwaccel videotoolbox` 参数
- `extractFrames` 先尝试 GPU 硬解，失败自动回退软解
- M1 芯片上解码 1080p 视频可从 ~30fps 提升至 >200fps
- 仅对 `video-helper.mjs` 中的 ffmpeg 帧提取部分生效

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
