# mock-cabin 曲库目录

往这里丢音频文件，车机端就能把它们放出来。

## 两种形态，出声位不在同一台机器上（M63）

| 形态 | 谁出声 | 什么时候是它 |
|---|---|---|
| **车机端认领**（常态） | cockpit 客户端：经网关拉走曲目字节，用 rodio 自己解码播放（只解 WAV / FLAC / Vorbis） | 只要车机端起着并认领了出声位（`/health` 的 `clientSinks` ≥ 1） |
| **服务端后端**（单机 demo） | mock-cabin 进程自己 spawn `mpg123` / `afplay` | 没有任何车机端认领时的兜底 |

两条互斥：端认领时服务端后端立即停止，租约（5 秒）过期后再退回服务端。

部署形态下只有第一种成立：mock-cabin 运行在服务器的容器里，没有 mpg123 也没有声卡，
即使装上，出声的也是服务器而不是车内。因此
`MOCK_CABIN_AUDIO` 与下面关于播放后端的说明只对单机 demo 形态有意义。

## 演示素材：两条路，不要去找歌

```bash
corepack pnpm demo:music      #  9 首真实录音（下载，CC0）
corepack pnpm demo:media      # 13 条本地合成（10 儿歌 + 3 故事）+ 时长 sidecar
```

| 组 | 怎么来的 | 为什么是这条路 |
|---|---|---|
| `肖邦（Musopen CC0）` 9 首 | 从 archive.org 下 Musopen 的 CC0 录音 | 真人钢琴演奏。器乐最听得出合成痕迹，而公有领域的真实录音可以使用 |
| `Cabinhug 故事` 3 篇 | 项目自己的阿里云档 TTS（`qwen3-tts-flash`）合成 | 本机 `say` 是老一代系统 TTS，机器感明显；项目本身已接入神经网络 TTS |
| `Cabinhug 童谣` 10 首 | 本文件的加法合成器（正弦波叠泛音） | 听感接近音乐盒而非演唱。唱出来的儿歌几乎都还在版权期内，没有免费的真录音，见下 |

不下载商业音乐，但 CC0 的真实录音可以使用。
逐条来源与许可证在 [`PROVENANCE.md`](PROVENANCE.md)（那份入 git，音频不入）。

### 儿歌为什么还是合成的

没有可靠的免费真录音：archive.org 上标 public domain 的儿歌基本两类——
上传者自行标注的（实际多为商业 CD，标注不可信），或者 78 转老唱片
（年代够老的确实 PD，但是英文、留声机音质，且要逐条核出版年份）。
唱出来的儿歌绝大多数仍在版权期内。因此这 10 首留作合成占位，
名字里的「Cabinhug 童谣」即其标注。

生成器同时写一份 `library.json` 补时长：`probeDuration` 先试 `afinfo` 再试 `ffprobe`，
而 mock-cabin 跑在 Alpine 容器里，两个都没有，不补的话每一首的 `durationSec` 恒为 null。

那三篇故事是人声。哨兵开着时放它们有误唤醒的风险（见下面「选曲注意」），
演示唤醒功能时用肖邦那九首或童谣。

## 加一首歌

```bash
cp ~/Downloads/"某某 - 江湖天涯客.flac" mocks/cabin/media/
curl -sX POST localhost:8793/media/library | jq '.tracks[].title'   # 重扫，不用重启服务
```

文件名就是元数据，约定 **`艺人 - 曲名.flac`**（按第一个 ` - ` 拆，曲名里的连字符保得住）。
没有 ` - ` 就整个文件名当曲名、艺人为 `null`。

`trackId` 由文件名派生（`t-` + sha1 前 8 位），加歌删歌都不会让已有 id 漂移，
点歌不会像序号那样错位。

## 版权：这个目录不入 git

`.gitignore` 把所有音频挡在仓库外，只有那首程序合成的垫底曲例外。
不要提交商业发行的音乐：私有仓库也构成分发。演示机上各自放本地文件即可。

## 格式

用 FLAC（ACR-068）。出声位在车机端，而车机端只带 WAV / FLAC / Vorbis 解码：
车载设备随机出货的解码器涉及版税，端上不带 MP3/AAC。单曲不超过 20 MiB
（`TRACK_BYTES_LIMIT`），16 bit 立体声的 FLAC 约 5 分钟以内。

放进来的 mp3 / m4a 在容器形态（静音后端）下标成 `playable: false`，
`GET /media/library` 会带上原因与转换命令：

```bash
ffmpeg -i "艺人 - 曲名.mp3" -c:a flac "艺人 - 曲名.flac"
```

宿主直接运行 mock-cabin 的单机 demo 形态里，`mpg123` 后端只解 mp3/mp2，放不了 FLAC；
没有车机端认领时用 `MOCK_CABIN_AUDIO=afplay` 让主机出声。

## 选曲注意：**别放有人声的**

车机端的语音哨兵一直在听。有人声的歌会被 ASR 转写，歌词里出现「暖暖」的同音近音
就会误唤醒（`voice/wake.rs` 的判定是拼音归一后同音计命中）。
TTS 播报期间靠 `TTS_PLAYING` 丢帧，但音乐要连放几分钟，不能全程丢帧，
否则放歌期间无法唤醒助手。所以现场用纯器乐。

## 覆盖元数据（可选）

曲名里本来就带 ` - `、或想手写时长，放一份 `library.json`：

```json
{
  "某某 - 江湖天涯客.flac": { "title": "江湖天涯客", "artist": "某某", "durationSec": 248 }
}
```

按文件名索引，只覆盖写了的字段。JSON 打错字不会让曲库变空（会整份忽略）。

## 目录换个地方

`MOCK_CABIN_MEDIA_DIR=/path/to/music` 指到别处，默认是本目录。

容器形态下本目录以只读方式挂载（`infra/docker-compose.stack.yml`），
不进镜像：音频不入 git，无法随镜像发布。

## 相关环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `MOCK_CABIN_MEDIA_DIR` | 本目录 | 曲库目录 |
| `MOCK_CABIN_AUDIO` | 自动探测 | `off` 静音（测试用）；`mpg123` / `afplay` 强制指定后端，用来验证降级表现 |
| `MOCK_CABIN_AUDIBLE_ZONE` | `cabin` | 哪个媒体分区真的出声（主机只有一对喇叭） |
