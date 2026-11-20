import re
from PySide6 import QtWidgets
from PySide6.QtCore import Qt, Signal, Slot, QObject, QSignalBlocker
import lib.qtlib as qtlib
from config import Config


class SizeBucket:
    BUCKET_SPLIT = re.compile(r'[ ,x]+')
    INACTIVE_PREFIX = "#"

    def __init__(self, w: int, h: int, length: int = -1, active: bool = True):
        self.w = w
        self.h = h
        self.length = length
        self.active = active

        self.area = w*h
        self.aspect = w/h

    def __str__(self) -> str:
        return "".join((
            "" if self.active else "#",
            f"{self.w}x{self.h}",
            "" if self.length < 0 else f"x{self.length}",
        ))

    @classmethod
    def filterActivePresets(cls, presets: list[str]) -> list[str]:
        return [preset[0] for preset in map(cls._parseActive, presets) if preset[1]]

    @classmethod
    def parse(cls, text: str) -> 'SizeBucket | None':
        textStrip, active = cls._parseActive(text)
        if not textStrip:
            return None

        elements = cls.BUCKET_SPLIT.split(textStrip)
        if len(elements) not in (2, 3):
            raise ValueError(f"Invalid element count for bucket size: {text!r}")

        try:
            w = int(elements[0])
            h = int(elements[1])
            length = int(elements[2]) if len(elements) == 3 else -1
            return SizeBucket(w, h, length, active)

        except ValueError:
            raise ValueError(f"Invalid format for bucket size: {text!r}")

    @classmethod
    def _parseActive(cls, text: str) -> tuple[str, bool]:
        text = text.strip()
        active = not text.startswith(cls.INACTIVE_PREFIX)
        text = text.lstrip(cls.INACTIVE_PREFIX).lstrip()
        return text, active



class SizePresetSignals(QObject):
    sizePresetsUpdated = Signal(list)

SIZE_PRESET_SIGNALS = SizePresetSignals()



class SizePresetWidget(QtWidgets.QWidget):
    BUCKET_SPLIT = re.compile(r'[ ,x]')

    def __init__(self):
        super().__init__()
        self._build()

        self.reloadSizeBuckets()
        SIZE_PRESET_SIGNALS.sizePresetsUpdated.connect(self.reloadSizeBuckets)

    def _build(self):
        layout = QtWidgets.QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)

        layout.addWidget(QtWidgets.QLabel("Width x Height (x Frames), one per line.\nPrefix # disables a line."))

        self.txtBuckets = QtWidgets.QPlainTextEdit()
        layout.addWidget(self.txtBuckets)

        self.setLayout(layout)

    def parseSizeBuckets(self, includeSwapped: bool = False, includeInactive: bool = False) -> list[SizeBucket]:
        buckets = list[SizeBucket]()
        for line in self.txtBuckets.toPlainText().splitlines():
            try:
                bucket = SizeBucket.parse(line)
                if bucket is None or not (includeInactive or bucket.active):
                    continue

                buckets.append(bucket)
                if includeSwapped and bucket.w != bucket.h:
                    buckets.append(SizeBucket(bucket.h, bucket.w, bucket.length, bucket.active))

            except ValueError as ex:
                print(str(ex))

        return buckets

    @Slot(list)
    def reloadSizeBuckets(self, presets: list[str] | None = None):
        if presets is None:
            presets = Config.cropSizePresets

        text = "\n".join(presets)
        self.txtBuckets.setPlainText(text)

    @Slot()
    def saveSizeBuckets(self):
        buckets = [str(bucket) for bucket in self.parseSizeBuckets(includeInactive=True)]
        Config.cropSizePresets = buckets
        SIZE_PRESET_SIGNALS.sizePresetsUpdated.emit(buckets)



class SizePresetWindow(QtWidgets.QDialog):
    def __init__(self, parent: QtWidgets.QWidget) -> None:
        super().__init__(parent)
        self._build()

        self.setWindowModality(Qt.WindowModality.ApplicationModal)
        self.setWindowTitle("Setup Size Presets")
        self.resize(400, 400)

    def _build(self):
        sizePresetWidget = SizePresetWidget()
        layout = QtWidgets.QGridLayout(self)

        row = 0
        layout.setRowStretch(row, 1)
        layout.addWidget(sizePresetWidget, row, 0, 1, 3)

        row += 1
        btnApply = QtWidgets.QPushButton("Save")
        btnApply.clicked.connect(sizePresetWidget.saveSizeBuckets)
        btnApply.clicked.connect(self.accept)
        layout.addWidget(btnApply, row, 0)

        btnReload = QtWidgets.QPushButton("Reload")
        btnReload.clicked.connect(lambda: sizePresetWidget.reloadSizeBuckets())
        layout.addWidget(btnReload, row, 1)

        btnCancel = QtWidgets.QPushButton("Cancel")
        btnCancel.clicked.connect(self.reject)
        layout.addWidget(btnCancel, row, 2)

        self.setLayout(layout)



class SizePresetComboBox(qtlib.MenuComboBox):
    presetSelected = Signal(int, int, int)  # w, h, length

    def __init__(self):
        super().__init__("Size Presets")
        self.reloadPresets(Config.cropSizePresets)
        self.currentTextChanged.connect(self._onPresetSelected)
        SIZE_PRESET_SIGNALS.sizePresetsUpdated.connect(self.reloadPresets)

    @Slot(list)
    def reloadPresets(self, presets: list[str]):
        with QSignalBlocker(self):
            self.clear()
            self.addItemWithoutMenuAction("")
            self.addItems(SizeBucket.filterActivePresets(presets))

            self.addSeparator()
            actShowSetup = self.addMenuAction("Setup Sizes...")
            actShowSetup.triggered.connect(self.showSetupWindow)

    @Slot()
    def showSetupWindow(self):
        win = SizePresetWindow(self)
        win.exec()

    @Slot(str)
    def _onPresetSelected(self, text: str):
        try:
            if bucket := SizeBucket.parse(text):
                self.presetSelected.emit(bucket.w, bucket.h, bucket.length)
        except ValueError as ex:
            print(f"Warning: Invalid size preset: {ex}")
        finally:
            with QSignalBlocker(self):
                self.setCurrentIndex(0)

    def selectFirstPreset(self):
        self.setCurrentIndex(1)
