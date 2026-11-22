// 独立语法/逻辑校验：直接复制 cpp/Decoder.cpp 中改造后的 align_pts 与
// try_reconnect 的状态字段，脱离 FFmpeg/CUDA/torch 头文件编译，验证改动本身
// 是合法 C++ 且行为与 streaming/pts_align.py 的参考实现一致。
#include <cassert>
#include <cmath>
#include <cstdio>
#include <vector>

struct DecoderLogic {
    double fps = 25.0;
    int max_delay_ms = 200;
    int reconnect_attempts = 0;
    int reconnect_count = 0;
    bool reconnect_pending = false;
    double last_input_pts = -1.0;
    double last_output_pts = -1.0;
    double nominal_frame_delta = 0.04;  // 1/25
    double pts_offset = 0.0;

    // ---- 与 Decoder.cpp 中完全相同的实现（逐行复制） ----
    double align_pts(double pts) {
        const double expected =
            nominal_frame_delta > 0.0 ? nominal_frame_delta : (fps > 0.0 ? 1.0 / fps : 0.04);

        if (pts < 0.0) {
            if (last_output_pts < 0.0) {
                last_output_pts = 0.0;
            } else {
                last_output_pts += expected;
            }
            return last_output_pts;
        }

        if (last_input_pts < 0.0) {
            last_input_pts = pts;
            if (last_output_pts < 0.0) {
                last_output_pts = 0.0;
            } else {
                last_output_pts += expected;
            }
            pts_offset = last_output_pts - pts;
            return last_output_pts;
        }

        double raw_delta = pts - last_input_pts;
        last_input_pts = pts;
        if (raw_delta <= 0.0) {
            raw_delta = expected;
        }
        double tol = max_delay_ms > 0 ? (max_delay_ms / 1000.0) : (expected * 2.0);
        double min_delta = expected - tol;
        if (min_delta < 0.0) min_delta = 0.0;
        double max_delta = expected + tol;
        if (raw_delta < min_delta || raw_delta > max_delta) {
            raw_delta = expected;
        }
        last_output_pts += raw_delta;
        pts_offset = last_output_pts - pts;
        return last_output_pts;
    }

    void on_reconnect_reset() {
        last_input_pts = -1.0;
        pts_offset = 0.0;
    }

    bool consume_reconnect() {
        bool pending = reconnect_pending;
        reconnect_pending = false;
        return pending;
    }
};

static bool close(double a, double b, double eps = 1e-9) { return std::fabs(a - b) < eps; }

int main() {
    const double d = 0.04;

    // 1. 正常连续帧
    DecoderLogic dec;
    std::vector<double> out;
    for (int i = 0; i < 100; ++i) out.push_back(dec.align_pts(i * d));
    assert(close(out[0], 0.0));
    for (size_t i = 1; i < out.size(); ++i) {
        assert(out[i] > out[i - 1]);
        assert(close(out[i] - out[i - 1], d, 1e-12));
    }

    // 2. 回退帧不破坏单调
    double before = out.back();
    double rolled = dec.align_pts(0.0);
    assert(rolled > before && close(rolled, before + d, 1e-12));

    // 3. 大跳被钳制
    double jumped = dec.align_pts(10.0);
    assert(close(jumped, rolled + d, 1e-12));

    // 4. 重连：源基准复位，输出轴保留，首帧从输出轴续接
    double axis = dec.last_output_pts;
    dec.on_reconnect_reset();
    assert(dec.last_input_pts == -1.0);
    assert(dec.last_output_pts == axis);
    double first_after = dec.align_pts(0.0);
    assert(close(first_after, axis + d, 1e-12));

    // 5. 重连后完整序列仍单调且间隔标称
    DecoderLogic d2;
    std::vector<double> seq;
    for (int i = 0; i < 30; ++i) seq.push_back(d2.align_pts(i * d));
    d2.on_reconnect_reset();
    seq.push_back(d2.align_pts(0.0));
    for (int i = 1; i < 30; ++i) seq.push_back(d2.align_pts(i * d));
    for (size_t i = 1; i < seq.size(); ++i) {
        assert(seq[i] > seq[i - 1]);
        assert(close(seq[i] - seq[i - 1], d, 1e-12));
    }

    // 6. consume_reconnect 边沿语义
    dec.reconnect_pending = true;
    assert(dec.consume_reconnect());
    assert(!dec.consume_reconnect());

    // 7. 长时间运行 nominal 不漂移（字段本身不被修改）
    DecoderLogic d3;
    double nominal = d3.nominal_frame_delta;
    for (int i = 0; i < 10000; ++i) d3.align_pts(i * nominal + (i % 2 ? 0.01 : -0.01));
    assert(close(d3.nominal_frame_delta, nominal, 1e-15));

    std::printf("C++ align_pts 全部断言通过，共 %d 个输出点\n", (int)seq.size());
    return 0;
}
