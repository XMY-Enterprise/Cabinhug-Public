//! rodio 从内存直解音频进声卡（ACR-004）。
//!
//! 端上只带 WAV / FLAC / Vorbis 解码（ACR-068：车载设备不带 MP3/AAC 解码器）；
//! TTS 由网关一律下发 WAV（ACR-067）。
//!
//! 不走"写临时文件 → afplay 子进程"：iOS 沙盒禁止 spawn，临时文件还有同名并发互踩、
//! /tmp 清扫的问题；内存直解不存在这一类问题。
//! 输出流每次新开：流的生命周期就是这一次播报的生命周期，与 `Playback` 一起被 halt/drop 回收。
//!
//! **没有 AEC 参考信号旁路**（车机的 `RenderTap`）：那是车机差异项。

use std::io::Cursor;

use crate::state::Playback;

/// `gain` 是 0.0~1.0 的增益（[`crate::state::gain_for_percent`] 算出来的）。
pub fn start_playback(audio: Vec<u8>, gain: f32) -> Result<Playback, String> {
    let device = rodio::DeviceSinkBuilder::open_default_sink()
        .map_err(|e| format!("打开音频输出失败: {e}"))?;
    let player = rodio::Player::connect_new(device.mixer());
    // 音量在 append 之前设：先出第一帧再压下去，每句开头都会有一小截原始响度。
    player.set_volume(gain);
    player.append(decode(audio)?);
    Ok(Playback { player, _device: device })
}

/// 按字节嗅探格式解码；不开声卡，单测可直接调。
fn decode(audio: Vec<u8>) -> Result<rodio::Decoder<Cursor<Vec<u8>>>, String> {
    rodio::Decoder::new(Cursor::new(audio)).map_err(|e| format!("音频解码失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::decode;
    use rodio::Source;

    /// 网关封装的同形 WAV（ACR-067）：44 字节头 + 16 bit 单声道 24 kHz 静音。
    fn wav_24k_mono(samples: usize) -> Vec<u8> {
        let data_len = (samples * 2) as u32;
        let mut wav = Vec::with_capacity(44 + samples * 2);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // 单声道
        wav.extend_from_slice(&24_000u32.to_le_bytes());
        wav.extend_from_slice(&48_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.resize(44 + samples * 2, 0);
        wav
    }

    #[test]
    fn decodes_gateway_wav() {
        let d = decode(wav_24k_mono(2400)).expect("WAV 必须能解：TTS 下发的就是它");
        assert_eq!(d.sample_rate().get(), 24_000);
        assert_eq!(d.channels().get(), 1);
    }

    #[test]
    fn decodes_flac() {
        // 演示曲库是 FLAC（ACR-068）；夹具由 `flac --best` 从 0.1 秒静音编码
        let flac = include_bytes!("../tests/fixtures/silence-100ms.flac").to_vec();
        let d = decode(flac).expect("FLAC 必须能解：车内音乐的曲库格式");
        assert_eq!(d.sample_rate().get(), 24_000);
        assert_eq!(d.channels().get(), 1);
    }

    #[test]
    fn undecodable_bytes_report_generic_error() {
        let err = decode(b"not audio at all".to_vec()).err().expect("应当解不了");
        assert!(err.starts_with("音频解码失败"), "{err}");
    }
}
