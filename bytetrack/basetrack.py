import numpy as np


class TrackState(object):
    New = 0
    Tracked = 1
    Lost = 2
    Removed = 3


class BaseTrack(object):
    # 类级计数器仅用于向后兼容（历史代码/单实例场景）。多 Pipeline 同进程运行时
    # 各跟踪器应通过自己的 id 计数器实例分配 ID，避免轨迹编号跨流串号，
    # 详见 FastByteTracker 的 id_counter 与 FastSTrack.activate。
    _count = 0

    track_id = 0
    is_activated = False
    state = TrackState.New

    score = 0
    start_frame = 0
    frame_id = 0
    time_since_update = 0

    # multi-camera
    location = (np.inf, np.inf)

    @property
    def end_frame(self):
        return self.frame_id

    @staticmethod
    def next_id():
        BaseTrack._count += 1
        return BaseTrack._count

    @staticmethod
    def reset_id():
        BaseTrack._count = 0

    def activate(self, *args):
        raise NotImplementedError

    def predict(self):
        raise NotImplementedError

    def update(self, *args, **kwargs):
        raise NotImplementedError

    def mark_lost(self):
        self.state = TrackState.Lost

    def mark_removed(self):
        self.state = TrackState.Removed
