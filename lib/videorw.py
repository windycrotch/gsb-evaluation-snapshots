import os
import numpy as np
import cv2 as cv
from PIL import Image


READ_EXTENSIONS = frozenset((
    '.3g2', '.3gp', '.amv', '.asf', '.avi', '.divx', '.dv', '.f4v', '.flv',
    '.h264', '.h265', '.hevc', '.m2ts', '.mts',
    '.m1v', '.m2v', '.m4p', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.mpv', '.mxf',
    '.ogv', '.qt', '.rm', '.rmvb', '.ts', '.vob', '.webm', '.wtv', '.wmv',
))

def isVideoFile(path: str) -> bool:
    ext = os.path.splitext(path)[1].lower()
    return ext in READ_EXTENSIONS


def sampleSingleFrame(fps: float) -> bool:
    return fps < 0.01


# Read metadata with OpenCV because AV doesn't account for rotation (would need to decode frames)
def readSize(path: str) -> tuple[int, int]:
    cap = cv.VideoCapture(path)
    try:
        if cap.isOpened():
            return cvGetFrameSize(cap)
    except:
        pass
    finally:
        cap.release()

    return -1, -1

def readMetadata(path: str) -> tuple[int, int, float, int, int]:
    'w, h, fps, frame count, duration (ms)'
    cap = cv.VideoCapture(path)
    try:
        if cap.isOpened():
            w, h = cvGetFrameSize(cap)
            frameCount = int(cap.get(cv.CAP_PROP_FRAME_COUNT))
            fps = cap.get(cv.CAP_PROP_FPS)
            duration = int(1000 * frameCount / fps)
            return w, h, fps, frameCount, duration
    except:
        pass
    finally:
        cap.release()

    return -1, -1, 0.0, 0, 0

def cvGetFrameSize(cap: cv.VideoCapture) -> tuple[int, int]:
    w = int(cap.get(cv.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv.CAP_PROP_FRAME_HEIGHT))

    sarNum = cap.get(cv.CAP_PROP_SAR_NUM)
    sarDen = cap.get(cv.CAP_PROP_SAR_DEN)
    try:
        sar = sarNum / sarDen
        if sar >= 1.0:
            w = round(w * sar)
        else:
            h = round(h / sar)
    except ZeroDivisionError:
        pass

    return w, h



# ========== AV ==========
try:
    import av
    from av.container import InputContainer
    from av.video.reformatter import VideoReformatter, Interpolation
    from typing import Callable

    FrameConvertFunc = Callable[[av.VideoFrame], np.ndarray]
    ConverterFactory = Callable[[int, int], FrameConvertFunc]

    CV_ROT_SWAP = {
        -90:  (cv.ROTATE_90_CLOCKWISE, True),
        90:   (cv.ROTATE_90_COUNTERCLOCKWISE, True),
        -180: (cv.ROTATE_180, False),
        180:  (cv.ROTATE_180, False),
        -270: (cv.ROTATE_90_COUNTERCLOCKWISE, True),
        270:  (cv.ROTATE_90_CLOCKWISE, True)
    }

    def createFrameConverter(
        w: int|None = None, h: int|None = None, rotate: bool = True,
        interpolation: Interpolation = None, format: str = "rgb24", threads: int = 0
    ) -> FrameConvertFunc:
        reformatter = VideoReformatter()
        rotSwapMap = CV_ROT_SWAP if rotate else {}

        def convert(frame: av.VideoFrame) -> np.ndarray:
            rotation = frame.rotation
            frame = reformatter.reformat(frame, w, h, format, interpolation=interpolation, threads=threads)
            mat = frame.to_ndarray()

            if rotSwap := rotSwapMap.get(rotation):
                mat = cv.rotate(mat, rotSwap[0])

            return mat

        return convert


    def avGetFrameSize(stream: av.VideoStream) -> tuple[int, int]:
        w = stream.width
        h = stream.height

        try:
            sar = stream.sample_aspect_ratio
            if sar is not None:
                sar = float(sar)
                if sar >= 1.0:
                    w = round(w * sar)
                else:
                    h = round(h / sar)
        except:
            pass

        return w, h

    def getKeyframes(path: str, start: int, end: int) -> list[int]:
        keyframes = list[int]()

        try:
            with av.open(path, 'r') as container:
                stream = container.streams.video[0]
                tb = stream.time_base

                startPts = int((start / 1000) / tb)
                endPts   = int((end / 1000) / tb)

                container.seek(startPts, stream=stream)
                for packet in container.demux(stream):
                    pts = packet.pts or -1
                    if pts > endPts:
                        break

                    if packet.is_keyframe and pts >= startPts:
                        keyframes.append(round(float(pts * tb) * 1000))

        except Exception as ex:
            print(f"Failed to extract keyframes: {ex} ({type(ex).__name__})")

        return keyframes


    class NotSeekableException(Exception): pass

    def iterKeyframes(container: InputContainer, numFrames: int, posFunc: Callable[[int], float]):
        'posFunc: Must return position as [0.0, 1.0]'

        duration = float(container.duration / av.time_base)
        stream = container.streams.video[0]
        tb = stream.time_base

        i = 0
        try:
            lastPts = -1
            for i in range(numFrames):
                targetPts = int((posFunc(i) * duration) / tb)
                container.seek(targetPts, stream=stream)

                frame = next(container.decode(stream))
                pts = frame.pts #or 0
                if pts > lastPts:
                    lastPts = pts
                    yield frame
                else:
                    raise NotSeekableException()

        except NotSeekableException:
            duration = min(duration, 60.0)

            for i in range(i, numFrames):
                targetPts = int((posFunc(i) * duration) / tb)

                frame = None
                for frame in container.decode(stream):
                    if frame.pts >= targetPts:
                        yield frame
                        break
                else:
                    if frame:
                        yield frame
                    break

    def iterFrames(container: InputContainer, numFrames: int, posFunc: Callable[[int], float], seek: bool = True):
        'posFunc: Must return position as seconds'

        stream = container.streams.video[0]
        tb = stream.time_base
        lastSeekPts = -1

        for i in range(numFrames):
            targetPts = int(posFunc(i) / tb)
            if seek:
                container.seek(targetPts, stream=stream)

            frame = None
            for f, frame in enumerate(container.decode(stream)):
                pts = frame.pts #or 0
                if f == 0 and seek:
                    # Disable seeking if it didn't move forward
                    if pts > lastSeekPts:
                        lastSeekPts = pts
                    else:
                        seek = False

                if pts >= targetPts:
                    yield frame
                    break
            else:
                if frame:
                    yield frame
                break


    def thumbnailVideo(path: str, maxWidth: int, tiling: int) -> tuple[np.ndarray, tuple[int, int]]:
        with av.open(path, 'r') as container:
            stream = container.streams.video[0]

            origW, origH = avGetFrameSize(stream)
            w = origW
            h = origH

            maxWidth = round(maxWidth / tiling)
            tiles: np.ndarray = None
            convert: FrameConvertFunc = None

            rotation: int | None = None
            swap: bool = False

            def prepareTiles(frame: av.VideoFrame):
                nonlocal w, h, rotation, swap, tiles, convert
                rotation, swap = CV_ROT_SWAP.get(frame.rotation, (None, False))
                if swap:
                    if h > maxWidth:
                        w = round(w * maxWidth/h)
                        h = maxWidth
                else:
                    if w > maxWidth:
                        h = round(h * maxWidth/w)
                        w = maxWidth

                convert = createFrameConverter(w, h, False, Interpolation.AREA, threads=2)
                tiles = np.zeros((h*tiling, w*tiling, 3), dtype=np.uint8)

            def addTile(i: int, frame: av.VideoFrame):
                if i == 1:
                    prepareTiles(frame)

                y, x = divmod(i-1, tiling)
                x *= w
                y *= h

                tiles[y:y+h, x:x+w, :] = convert(frame)

            # Extract evenly spaced frames
            numIntervals = tiling*tiling + 1
            posFunc = lambda i: (i+1) / numIntervals

            try:
                for i, frame in enumerate(iterKeyframes(container, numIntervals-1, posFunc), 1):
                    addTile(i, frame)
            except Exception as ex:
                print(f"Video thumbnail incomplete: {ex} ({type(ex).__name__})")

        if rotation is not None:
            tiles = cv.rotate(tiles, rotation)
            if swap:
                origW, origH = origH, origW

        return tiles, (origW, origH)


    # For captioning models
    def extractFramesPIL(source, sampleFps: float, maxFrames: int = 32) -> tuple[list[Image.Image], dict]:
        with av.open(source, 'r') as container:
            stream = container.streams.video[0]

            w, h = avGetFrameSize(stream)
            convert = createFrameConverter(w, h)

            duration = float(container.duration / av.time_base)

            if sampleSingleFrame(sampleFps):
                numSampleFrames = 1
                sampleFps = 0.0
                seek = False
                posFunc = lambda i: -100.0
            else:
                fps = float(stream.average_rate or 0)
                frameCount = stream.frames or int(duration * fps)

                numSampleFrames = min(int(duration * sampleFps), frameCount)
                numSampleFrames &= ~1  # Force even frame count by rounding down
                numSampleFrames = min(max(numSampleFrames, 2), maxFrames)
                sampleFps = numSampleFrames / duration

                posFeed = duration / (numSampleFrames-1) if numSampleFrames < frameCount-1 else 0
                seek = (posFeed * fps > 24)
                posFunc = lambda i: i * posFeed

            frames = list[Image.Image]()
            try:
                for frame in iterFrames(container, numSampleFrames, posFunc, seek):
                    frames.append(Image.fromarray(convert(frame)))
            except Exception as ex:
                print(f"Warning: {ex} ({type(ex).__name__})")

        if not frames:
            raise RuntimeError("Failed to extract video frames")
        elif len(frames) < numSampleFrames:
            print(f"Warning: Could not extract all frames from video ({len(frames)}/{numSampleFrames})")

        metadata = {
            "fps": sampleFps,
            "frames_indices": list(range(len(frames))),
            "total_num_frames": len(frames),
            "duration": duration
        }

        return frames, metadata


    # For tagging models
    def extractFramesMat(source, sampleFps: float, maxFrames: int, converterFactory: ConverterFactory) -> list[np.ndarray]:
        with av.open(source, 'r') as container:
            stream = container.streams.video[0]

            w, h = avGetFrameSize(stream)
            convert = converterFactory(w, h)

            duration = float(container.duration / av.time_base)
            fps = float(stream.average_rate or 0)
            frameCount = stream.frames or int(duration * fps)

            numSampleFrames = min(round(duration * sampleFps), frameCount)
            numSampleFrames = min(max(numSampleFrames, 3), maxFrames)

            frames = list[np.ndarray]()
            try:
                # Short videos: Exact seeking, include first and last frame
                if duration <= 10.0:
                    posFunc = lambda i: duration * i / (numSampleFrames-1)
                    for frame in iterFrames(container, numSampleFrames, posFunc):
                        frames.append(convert(frame))

                # Long videos: Seek to keyframes only, exclude first and last interval
                else:
                    numIntervals = numSampleFrames + 1
                    posFunc = lambda i: (i+1) / numIntervals
                    for frame in iterKeyframes(container, numSampleFrames, posFunc):
                        frames.append(convert(frame))

            except Exception as ex:
                print(f"Warning: {ex} ({type(ex).__name__})")

        if not frames:
            raise RuntimeError("Failed to extract video frames")
        elif len(frames) < numSampleFrames:
            print(f"Warning: Could not extract all frames from video ({len(frames)}/{numSampleFrames})")

        return frames



# ========== OpenCV ==========
except ImportError:

    def getKeyframes(path: str, start: int, end: int) -> list[int]:
        startSec = start / 1000.0
        endSec   = end / 1000.0
        interval = f"{startSec}%{endSec}"

        cmd = [
            'ffprobe', '-v', 'error', '-skip_frame', 'nokey', '-select_streams', 'v:0', '-show_entries', 'frame=pkt_pts_time',
            '-read_intervals', interval, '-of', 'csv=p=0', path
        ]

        try:
            import subprocess
            result = subprocess.check_output(cmd, text=True)
            return [round(float(line) * 1000.0) for l in result.splitlines() if (line := l.strip())]
        except Exception as ex:
            print(f"Failed to extract keyframes: {ex} ({type(ex).__name__})")
            return []


    def thumbnailVideo(path: str, maxWidth: int, tiling: int) -> tuple[np.ndarray, tuple[int, int]]:
        cap = cv.VideoCapture(path)
        try:
            if not cap.isOpened():
                raise ValueError(f"Could not open video file: {path}")

            fps = cap.get(cv.CAP_PROP_FPS)
            frameCount = int(cap.get(cv.CAP_PROP_FRAME_COUNT))

            try:
                duration = frameCount / fps
            except ZeroDivisionError:
                raise ValueError("Failed to retrieve video duration")

            # Extract evenly spaced frames
            numIntervals = tiling*tiling + 1
            frames = list[np.ndarray]()
            for i in range(1, numIntervals):
                pos = round(1000 * i * duration/numIntervals)
                cap.set(cv.CAP_PROP_POS_MSEC, pos)
                ret, frame = cap.read()
                if ret:
                    frames.append(frame)
                else:
                    break

        finally:
            cap.release()

        try:
            origH, origW, channels = frames[0].shape
        except IndexError:
            raise ValueError("Failed to extract video frames")
        except ValueError:
            origH, origW = frames[0].shape[:2]
            channels = 1

        # Downscale frames
        maxWidth = round(maxWidth / tiling)
        w, h = origW, origH
        if w > maxWidth:
            h = round(h * maxWidth/w)
            w = maxWidth
            frames = [cv.resize(frame, (w, h), interpolation=cv.INTER_AREA) for frame in frames]

        # Tile
        tiles = np.zeros((h*tiling, w*tiling, channels), dtype=np.uint8)
        for i, frame in enumerate(frames):
            x = (i % tiling) * w
            y = (i // tiling) * h
            tiles[y:y+h, x:x+w, :] = frame

        tiles[..., :3] = tiles[..., 2::-1] # Convert BGR(A) -> RGB(A)
        return tiles, (origW, origH)


    def extractFramesPIL(path: str, sampleFps: float, maxFrames: int = 32) -> tuple[list[Image.Image], dict]:
        cap = cv.VideoCapture(path)
        try:
            if not cap.isOpened():
                raise ValueError(f"Could not open video file: {path}")

            fps = cap.get(cv.CAP_PROP_FPS)
            frameCount = int(cap.get(cv.CAP_PROP_FRAME_COUNT))

            try:
                duration = frameCount / fps
            except ZeroDivisionError:
                raise ValueError("Failed to retrieve video duration")

            numSampleFrames = min(int(duration * sampleFps), frameCount)
            numSampleFrames &= ~1  # Force even frame count by rounding down
            numSampleFrames = min(max(numSampleFrames, 2), maxFrames)
            sampleFps = numSampleFrames / duration

            frames = list[np.ndarray]()
            posFeed = duration / (numSampleFrames-1)
            for i in range(numSampleFrames):
                pos = int(1000 * i * posFeed)
                cap.set(cv.CAP_PROP_POS_MSEC, pos)
                ret, frame = cap.read()
                if ret:
                    frame[..., :3] = frame[..., 2::-1] # Convert BGR(A) -> RGB(A)
                    frames.append(frame)
                else:
                    break

        finally:
            cap.release()

        if not frames:
            raise RuntimeError("Failed to extract video frames")

        metadata = {
            "fps": sampleFps,
            "frames_indices": [i for i in range(len(frames))],
            "total_num_frames": len(frames),
            "duration": duration
        }

        images = [Image.fromarray(mat) for mat in frames]
        return images, metadata



# ========== Qt ==========
try:
    from PySide6.QtCore import Signal, Slot, QRectF, QSize, QProcess, QObject
    from PySide6.QtGui import QImage, QPolygonF, QTransform
    import math, time, os, uuid
    from lib import qtlib

    def thumbnailVideoQImage(path: str, maxWidth: int, tiling: int) -> tuple[QImage, tuple[int, int]]:
        mat, size = thumbnailVideo(path, maxWidth, tiling)
        return qtlib.numpyToQImage(mat, fromRGB=True), size


    class VideoExportSession(QProcess):
        '''
        One cancellable, retryable ffmpeg export of a single destination file.

        Invariants:
        - ffmpeg always writes to a unique temporary output, never directly to destFile.
        - destFile is created (by atomic rename) only when ffmpeg exits with code 0.
        - Every terminal signal is emitted at most once; late signals after cancel are ignored.
        - The session removes its temporary output on every non-success outcome.
        '''
        OVERWRITE_FLAG = '-y'  # '-n'

        done     = Signal(str, str, object) # srcFile, destFile, session
        progress = Signal(str, object)      # msg, session
        fail     = Signal(str, object)      # msg, session

        def __init__(
            self, parent,
            srcFile: str, srcSize: QSize, srcPosMs: int, srcFps: float,
            destFile: str, poly: QPolygonF | None, targetSize: QSize, rotation: float,
            numFrames: int, targetFps: float, speed: float = 1.0, owner: object | None = None
        ):
            super().__init__(parent)
            self.sessionId = uuid.uuid4().hex
            self.srcFile   = srcFile
            self.destFile  = os.path.abspath(destFile)
            # The tool instance that started the session; used to find and cancel sessions on tab close.
            self.owner     = owner
            self.tStart    = 0
            self.cancelled = False
            self.finishedCleanup = False

            # Unique per-session output so concurrent/retried sessions can never share a partial file.
            base, ext = os.path.splitext(self.destFile)
            self.tempFile = f"{base}.export-{self.sessionId}{ext}"

            videoFilters = self._getVideoFilters(srcSize, poly, targetSize, rotation, speed, srcFps, targetFps)
            audioFilters = None

            durationWrite = durationRead = numFrames / targetFps
            if abs(speed - 1.0) > 0.001:
                durationRead = durationWrite * speed
                videoFilters = [f'setpts=PTS/{speed}'] + videoFilters
                audioFilters = self._getAudioFilters(speed)

            keyframeInterval = round(targetFps)
            refFrames = '4'  # Prevents exceeding decode surface limit when playing these videos (preset veryslow uses 16 refs)

            args = ['-nostdin', self.OVERWRITE_FLAG, '-v', 'error', '-ss', f"{srcPosMs}ms"]

            if numFrames > 0:
                args += ['-t', str(durationRead), '-i', srcFile, '-ss', '0', '-t', str(durationWrite), '-frames:v', str(numFrames)]
            else:
                args += ['-i', srcFile, '-ss', '0']

            args += ['-vf', ','.join(videoFilters)]

            if audioFilters:
                args += ['-af', ','.join(audioFilters)]

            args += [
                '-c:v', 'libx264', '-preset', 'veryslow', '-crf', '17', '-movflags', '+faststart',
                '-c:a', 'aac', '-b:a', '192k',
                '-refs', refFrames, '-g', str(keyframeInterval),
                '-pix_fmt', 'yuv420p', '-avoid_negative_ts', 'make_zero',
                self.tempFile
            ]

            #print(f"ffmpeg args: {args}")

            self.setProgram("ffmpeg")
            self.setArguments(args)

            self.setProcessChannelMode(QProcess.ProcessChannelMode.ForwardedErrorChannel)
            self.started.connect(self._onProcessStarted)
            self.finished.connect(self._onProcessEnded)
            self.errorOccurred.connect(self._onProcessError)

        @staticmethod
        def _getAudioFilters(speed: float) -> list[str]:
            # atempo with speed>2 will skip samples instead of blending, so chain multiple filters (max 10)
            # minimum tempo argument is 0.5
            if speed >= 0.5:
                atempoCount = math.ceil(speed/2.0) if speed <= 20.0 else 1
            else:
                atempoCount = math.ceil(0.5/speed)

            atempoVal = pow(speed, 1.0/atempoCount)
            return [f'atempo={atempoVal}'] * atempoCount

        @classmethod
        def _getVideoFilters(
            cls, srcSize: QSize, poly: QPolygonF | None, targetSize: QSize, rotation: float, speed: float, srcFps: float, targetFps: float
        ) -> list[str]:
            bbox, crop = cls.calcRotatedCrop(srcSize, poly, rotation)
            filters = list[str]()

            if rotation != 0.0:
                rotRad = math.radians(rotation)
                filters.append( f'rotate={rotRad}:ow={bbox.width()}:oh={bbox.height()}:fillcolor=black@0' )

            if crop != bbox:
                filters.append( f'crop={crop.width()}:{crop.height()}:{crop.x()}:{crop.y()}' )

            targetSize = cls._evenSize(targetSize)
            if crop.size() != targetSize:
                filters.append( f'scale={targetSize.width()}:{targetSize.height()}:flags=lanczos' )  # TODO: Use interpolation settings from preset?

            scaledSrcFps = srcFps * speed
            if targetFps > scaledSrcFps * 1.33:
                filters.append( f"minterpolate=fps={targetFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:me=epzs:vsbmc=1" )
                print(f"Upsampling FPS from {round(srcFps, 4)} (speed: {speed:.2f}, effective FPS: {round(scaledSrcFps, 4)}) "
                      f"to {round(targetFps, 4)} (x{targetFps/scaledSrcFps:.3f}) using minterpolate filter. This can take a minute.")
            elif targetFps > scaledSrcFps:
                filters.append( f'fps={targetFps}' )      # Duplicates frames: Do this last
            else:
                filters = [f'fps={targetFps}'] + filters  # Drops frames: Do this first

            return filters

        @staticmethod
        def calcRotatedCrop(srcSize: QSize, poly: QPolygonF | None, rotation: float) -> tuple[QRectF, QRectF]:
            rotTrans = QTransform().rotate(rotation)                                 # Rotation around 0/0
            bbox = rotTrans.mapRect(QRectF(0, 0, srcSize.width(), srcSize.height())) # Bounding box of rotated image

            if poly is not None:
                crop = rotTrans.map(poly).boundingRect() # Rotate selection from image-space to view-space and align with axes
                crop.translate(-bbox.topLeft())          # Make crop window relative to bbox
                return bbox, crop
            else:
                return bbox, bbox

        @staticmethod
        def _evenSize(size: QSize) -> QSize:
            # ffmpeg needs target size divisible by 2
            w, h = size.toTuple()
            if (w & 1) or (h & 1):
                w -= (w & 1)
                h -= (h & 1)
                print(f"Video size must be even. Reducing from {size.width()}x{size.height()} to {w}x{h}.")
                return QSize(w, h)

            return size


        def cancel(self):
            '''Request termination. A terminated session never promotes its output.'''
            if self.cancelled or self.finishedCleanup:
                return
            self.cancelled = True
            print(f"Cancelling video export: {self.destFile}")
            self.progress.emit("Cancelling export...", self)

            if self.state() != QProcess.ProcessState.NotRunning:
                # kill() is forceful on every platform (TerminateProcess on Windows, SIGKILL on Unix).
                # terminate() cannot reach console processes on Windows and ffmpeg ignores it there;
                # the partial output is discarded on cancel anyway, so graceful shutdown has no benefit.
                self.kill()

        def _removeTempFile(self):
            '''Best-effort removal of the unfinished temporary output.'''
            try:
                if os.path.exists(self.tempFile):
                    os.remove(self.tempFile)
            except OSError as ex:
                print(f"Failed to remove incomplete export {self.tempFile}: {ex}")

        def _promoteOutput(self) -> bool:
            '''Atomically replace destFile with the completed temporary output.'''
            try:
                os.replace(self.tempFile, self.destFile)
                return True
            except OSError as ex:
                print(f"Failed to finalize export {self.destFile}: {ex}")
                self._removeTempFile()
                return False

        @Slot()
        def _onProcessStarted(self):
            self.tStart = time.monotonic_ns()
            self.progress.emit("Saving video...", self)

        @Slot(int, QProcess.ExitStatus)
        def _onProcessEnded(self, exitCode: int, exitStatus: QProcess.ExitStatus):
            # errorOccurred(FailedToStart) can also be queued; the guard in _finish makes this idempotent.
            if self.cancelled:
                self._finish(failMsg="Export cancelled")
            elif exitCode == 0 and exitStatus == QProcess.ExitStatus.NormalExit:
                t = (time.monotonic_ns() - self.tStart) / 1_000_000_000
                print(f"Video export took {t:.3f} s")
                if self._promoteOutput():
                    self._finish()
                else:
                    self._finish(failMsg="Export completed but the output could not be saved")
            else:
                self._finish(failMsg=f"ffmpeg call failed with exit code {exitCode}, {exitStatus}")

        @Slot()
        def _onProcessError(self, error: QProcess.ProcessError):
            # FailedToStart (e.g. ffmpeg missing) arrives without a following finished() signal.
            # Crashes also produce this, in which case finished() is usually emitted afterwards too.
            if error == QProcess.ProcessError.FailedToStart:
                self._finish(failMsg=f"ffmpeg could not be started ({error.name}). Is ffmpeg installed and on PATH?")
            elif self.cancelled:
                self._finish(failMsg="Export cancelled")
            else:
                self._finish(failMsg=f"ffmpeg error ({error.name})")

        def _finish(self, failMsg: str | None = None):
            '''Single terminal path: cleans up partial output and emits done or fail exactly once.'''
            if self.finishedCleanup:
                return
            self.finishedCleanup = True

            self.readAllStandardOutput()
            self.readAllStandardError()

            if failMsg is not None:
                print(f"Video export failed: {failMsg}")
                self._removeTempFile()
                self.fail.emit(failMsg, self)
            else:
                self.done.emit(self.srcFile, self.destFile, self)

            self.deleteLater()


    class VideoExportManager(QObject):
        '''
        Process-wide registry that serializes export sessions per destination file.

        Guarantees:
        - At most one active session writes to a given destination path at any time.
        - Starting a new session for a path first cancels and reaps the old one, then removes
          any leftover partial output, so the new session starts from a clean destination.
        - Sessions ending after they were superseded cannot touch UI state or new files:
          tools receive every signal together with the emitting session and filter by identity.
        '''
        def __init__(self, parent: QObject | None = None):
            super().__init__(parent)
            self._sessions: dict[str, VideoExportSession] = dict()

        def isExporting(self, destFile: str) -> bool:
            '''Whether an active session currently owns the given destination path.'''
            return os.path.abspath(destFile) in self._sessions

        def activeDestFiles(self) -> list[str]:
            '''Snapshot of destination paths with an active session.'''
            return list(self._sessions.keys())

        def startExport(self, session: VideoExportSession) -> VideoExportSession:
            '''
            Register and start a session for its destination, replacing any previous session.
            The previous session is cancelled, reaped synchronously, and its partial output removed
            before the new session is started.
            '''
            destFile = session.destFile
            self._retireSession(destFile)

            # Clean anything a crashed/killed previous process could have left behind.
            self._removeLeftoverOutputs(destFile)

            self._sessions[destFile] = session
            session.done.connect(self._onSessionDone)
            session.fail.connect(self._onSessionFail)
            session.start()
            return session

        def cancelExport(self, destFile: str) -> bool:
            '''Cancel the active session for a destination, if any. Returns whether one was found.'''
            session = self._sessions.get(os.path.abspath(destFile))
            if session is None:
                return False
            session.cancel()
            return True

        def cancelExportsOwnedBy(self, owner: object):
            '''Cancel every active session started by the given owner (e.g. a tool whose tab is closing).'''
            for session in list(self._sessions.values()):
                if session.owner is owner:
                    session.cancel()

        def reapExportsOwnedBy(self, owner: object):
            '''
            Synchronously cancel and reap every session of an owner that is being destroyed.
            The matching destinations are retired through the same path as a superseding export,
            so no ffmpeg process outlives the UI that started it.
            '''
            owned = [dest for dest, session in self._sessions.items() if session.owner is owner]
            for dest in owned:
                self._retireSession(dest)

        def _retireSession(self, destFile: str):
            '''
            Synchronously cancel an active session and reap its process before the caller continues.

            kill() + waitForFinished() is fully synchronous, so the old ffmpeg is guaranteed to have
            exited (and its partial output can be removed) by the time a replacement session starts.
            The session is finalized here as well; the later queued finished()/errorOccurred() slot is
            a no-op because _finish() is idempotent.
            '''
            old = self._sessions.pop(destFile, None)
            if old is None or old.finishedCleanup:
                return

            old.cancel()
            old.waitForFinished(5000)
            # Finalize immediately even if the terminal Qt signal is still queued behind us.
            if not old.finishedCleanup:
                old._finish(failMsg="Export cancelled")

        @staticmethod
        def _removeLeftoverOutputs(destFile: str):
            '''
            Remove per-session temporary files (".export-*") left next to a destination by a
            process that was killed or crashed before its own cleanup ran. The destination itself is
            never touched here: an earlier successful file at this path must survive a failed retry.
            '''
            base, ext = os.path.splitext(destFile)
            folder = os.path.dirname(base) or "."
            prefix = os.path.basename(base) + ".export-"

            try:
                names = os.listdir(folder)
            except OSError:
                names = []

            for name in names:
                if name.startswith(prefix) and name.endswith(ext):
                    try:
                        os.remove(os.path.join(folder, name))
                    except OSError as ex:
                        print(f"Failed to remove leftover export {name}: {ex}")

        @Slot(str, str, object)
        def _onSessionDone(self, srcFile: str, destFile: str, session: VideoExportSession):
            self._deregisterIfCurrent(destFile, session)

        @Slot(str, object)
        def _onSessionFail(self, msg: str, session: VideoExportSession):
            self._deregisterIfCurrent(session.destFile, session)

        def _deregisterIfCurrent(self, destFile: str, session: VideoExportSession):
            # A superseded session's late terminal signal must not remove the new owner's entry.
            if self._sessions.get(destFile) is session:
                del self._sessions[destFile]

        def cancelAll(self):
            '''Cancel every active session, reaping each process. Used on application shutdown.'''
            for destFile in list(self._sessions.keys()):
                self._retireSession(destFile)


    # Single process-wide manager: one owner per destination across all tabs and tools.
    VIDEO_EXPORT_MANAGER = VideoExportManager()

except ImportError:
    pass
