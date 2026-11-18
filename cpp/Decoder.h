#pragma once

#include <torch/extension.h>

#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/dict.h>
#include <libavutil/frame.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_cuda.h>
#include <libavutil/pixdesc.h>
}

#include <npp.h>

// 非流式点播源读到 EOF（重连不可用）时的正常结束信号，Python 侧可捕获
class EndOfFileError : public std::runtime_error {
public:
    explicit EndOfFileError(const std::string& msg) : std::runtime_error(msg) {}
};

// 流式源重连次数耗尽，判定信号丢失，Python 侧可捕获
class ReconnectExhaustedError : public std::runtime_error {
public:
    explicit ReconnectExhaustedError(const std::string& msg) : std::runtime_error(msg) {}
};

// 内部使用：输入源打开失败（可重试），用于区别于解码配置错误，不导出到 Python
class SourceOpenError : public std::runtime_error {
public:
    explicit SourceOpenError(const std::string& msg) : std::runtime_error(msg) {}
};

class Decoder {
public:
    Decoder(const std::string &filename,
            bool               enable_frame_skip     = false,
            int                output_width          = 0,
            int                output_height         = 0,
            bool               enable_auto_reconnect = true,
            int                reconnect_delay_ms    = 500,
            int                max_reconnects        = 0,
            int                open_timeout_ms       = 5000,
            int                read_timeout_ms       = 5000,
            int                buffer_size           = 4 * 1024 * 1024,
            int                max_delay_ms          = 200,
            int                reorder_queue_size    = 0,
            int                decoder_threads       = 2,
            int                surfaces             = 2,
            std::string        hwaccel              = "cuda");
    ~Decoder();

    std::pair<torch::Tensor, double> next_frame();
    int                              get_width() const { return width; }
    int                              get_height() const { return height; }
    double                           get_fps() const { return fps; }

private:
    void   init_ffmpeg(const std::string &filename);
    void   cleanup();
    bool   try_reconnect();
    double align_pts(double pts);

    AVFormatContext *format_ctx       = nullptr;
    AVCodecContext  *codec_ctx        = nullptr;
    AVBufferRef     *hw_device_ctx    = nullptr;
    int              video_stream_idx = -1;

    AVFrame  *frame  = nullptr;
    AVPacket *packet = nullptr;

    std::string source_url;
    int         width               = 0;
    int         height              = 0;
    int         decode_width        = 0;
    int         decode_height       = 0;
    int         requested_width     = 0;
    int         requested_height    = 0;
    double      fps                 = 0.0;
    bool        flushing            = false;
    bool        finished            = false;
    bool        enable_frame_skip   = false;
    bool        output_this_frame   = true;
    bool        enable_reconnect    = true;
    int         reconnect_delay_ms  = 500;
    int         max_reconnects      = 0;
    int         open_timeout_ms     = 5000;
    int         read_timeout_ms     = 5000;
    int         buffer_size         = 4 * 1024 * 1024;
    int         max_delay_ms        = 200;
    int         reorder_queue_size  = 0;
    int         decoder_threads     = 2;
    int         surfaces            = 2;
    std::string hwaccel             = "cuda";
    int         reconnect_attempts  = 0;
    bool        is_streaming_source = false;
    int         bad_frame_streak    = 0;
    double      last_input_pts      = -1.0;
    double      last_output_pts     = -1.0;
    double      nominal_frame_delta = 0.0;
    double      pts_offset          = 0.0;

    // NPP 流上下文：构造时初始化一次，每帧只更新 hStream
    NppStreamContext npp_stream_ctx_{};
    // 硬件帧的软件像素格式（NPP 目前仅支持 NV12）
    AVPixelFormat    sw_format = AV_PIX_FMT_NONE;
    // 输出显存复用，避免每帧 torch::empty；注意：下一次 next_frame() 会覆盖其内容
    torch::Tensor    bgr_buf_;
    torch::Tensor    resized_buf_;
};
