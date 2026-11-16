#!/usr/bin/env python3
"""
tests/test_resumable_scan.py

تست‌های آفلاین (بدون هیچ دسترسی شبکه) برای رفتار «وقفه‌ی قابل‌ادامه» در
صفحه‌بندی scan_channel و تصمیم چک‌پوینت در main.

همه‌ی صفحه‌ها با قطعه‌HTMLهای دست‌ساز (به شکل پیش‌نمایش وب تلگرام) و یک
نسخه‌ی کنترل‌شده از fetch_url شبیه‌سازی می‌شوند:
  - صفحه‌ی نخست موفق، صفحه‌ی دوم شکست می‌خورد و صفحه‌ی سوم فایل قدیمی دارد؛
    بررسی می‌کنیم دور بعد شکاف را دوباره می‌خواند و چک‌پوینت در دور وقفه
    جلو نمی‌رود.
  - مسیر منفی: شکست صفحه‌ی نخست همچنان به‌عنوان کانال نامعتبر (ERR) ثبت می‌شود.

اجرا:
    python -I -m unittest tests.test_resumable_scan -v
یا:
    python -I tests/test_resumable_scan.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# پوشه‌ی src را بدون نیاز به نصب پکیج به sys.path اضافه می‌کنیم.
SRC_DIR = Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(SRC_DIR))

import npvt_collector as mod  # noqa: E402


# ----------------------------------------------------------------------------
# سازنده‌ی قطعه‌HTMLهای دست‌ساز (هم‌شکل پیش‌نمایش وب t.me/s/<channel>)
# ----------------------------------------------------------------------------
def message_html(
    channel: str,
    msg_id: int,
    file_name: str | None = None,
    size_text: str = "1.0 MB",
    posted_at: str = "2026-11-16T10:00:00+00:00",
) -> str:
    """یک بلوک پیام t.me؛ اگر file_name بدهید یک ضمیمه‌ی سندی هم دارد."""
    if file_name:
        attachment = f"""
          <a class="tgme_widget_message_document" href="https://t.me/{channel}/{msg_id}?embed=1">
            <div class="tgme_widget_message_document_title">{file_name}</div>
            <div class="tgme_widget_message_document_extra">{size_text}</div>
          </a>"""
    else:
        attachment = ""
    return f"""
        <div data-post="{channel}/{msg_id}" class="tgme_widget_message_wrap">
          {attachment}
          <a class="tgme_widget_message_date" href="https://t.me/{channel}/{msg_id}">
            <time datetime="{posted_at}">{posted_at}</time>
          </a>
        </div>"""


def page_html(messages: list[str]) -> str:
    return '<div class="tgme_channel_history">' + "".join(messages) + "</div>"


def page_url(channel: str, before: int | None = None) -> str:
    return f"https://t.me/s/{channel}" + (f"?before={before}" if before else "")


class ControlledFetcher:
    """
    جایگزین کنترل‌شده‌ی fetch_url: نگاشت نشانی→HTML از پیش تعیین‌شده،
    مجموعه‌ی نشانی‌هایی که باید شکست بخورند (پاسخ خاطر)، و سیاهه‌ی فراخوانی‌ها.
    """

    def __init__(self, pages: dict[str, str], failing_urls: set[str] | None = None):
        self.pages = dict(pages)
        self.failing_urls = set(failing_urls or ())
        self.calls: list[str] = []

    def __call__(self, url: str) -> str:
        self.calls.append(url)
        if url in self.failing_urls:
            return ""  # همان قرارداد fetch_url واقعی: شکست → رشته‌ی خالی
        return self.pages.get(url, "")


# ----------------------------------------------------------------------------
# تست‌های واحد scan_channel / decide_checkpoint
# ----------------------------------------------------------------------------
class ScanChannelUnitTests(unittest.TestCase):
    def setUp(self):
        # هیچ خوابی در تست‌ها اجرا نشود.
        self._sleep_patch = mock.patch.object(mod.time, "sleep", lambda *a, **kw: None)
        self._sleep_patch.start()
        self._pages_patch = mock.patch.object(mod, "MAX_PAGES_PER_CHANNEL", 3)
        self._pages_patch.start()

    def tearDown(self):
        self._sleep_patch.stop()
        self._pages_patch.stop()

    def test_first_page_fetch_failure_is_invalid_not_interrupted(self):
        """مسیر منفی: شکست صفحه‌ی نخست → کانال نامعتبر، نه وقفه‌ی قابل‌ادامه."""
        fetcher = ControlledFetcher({}, failing_urls={page_url("deadchan")})
        with mock.patch.object(mod, "fetch_url", fetcher):
            result = mod.scan_channel("deadchan", 0)

        self.assertTrue(result.invalid)
        self.assertFalse(result.interrupted)
        self.assertEqual(result.found, [])
        self.assertIsNone(result.resume_after_id)
        self.assertEqual(fetcher.calls, [page_url("deadchan")])  # فقط یک تلاش

    def test_first_page_without_message_nodes_is_invalid(self):
        """صفحه‌ی نخست HTML دارد ولی هیچ پیامی ندارد → نامعتبر (مثل رفتار قدیمی)."""
        fetcher = ControlledFetcher({page_url("ghostchan"): "<html><body></body></html>"})
        with mock.patch.object(mod, "fetch_url", fetcher):
            result = mod.scan_channel("ghostchan", 0)

        self.assertTrue(result.invalid)
        self.assertFalse(result.interrupted)
        self.assertIsNone(result.resume_after_id)

    def test_second_page_failure_is_resumable_interruption(self):
        """شکست صفحه‌ی دوم: وقفه‌ی قابل‌ادامه با مرزِ قدیمی‌ترین پیامِ صفحات موفق."""
        pages = {
            page_url("ch"): page_html([
                message_html("ch", 100, "a.npvt"),
                message_html("ch", 99),  # پیام بدون ضمیمه
                message_html("ch", 98, "b.npvt"),
            ]),
            page_url("ch", before=98): "",  # صفحه‌ی دوم شکست می‌خورد
        }
        fetcher = ControlledFetcher(pages, failing_urls={page_url("ch", before=98)})
        with mock.patch.object(mod, "fetch_url", fetcher):
            result = mod.scan_channel("ch", 80)

        self.assertFalse(result.invalid)
        self.assertTrue(result.interrupted)
        # قدیمی‌ترین پیام صفحه‌ی موفق = 98 → مرز ادامه.
        self.assertEqual(result.resume_after_id, 98)
        # جدیدترین پیام دیده‌شده همچنان درست گزارش می‌شود.
        self.assertEqual(result.newest_id, 100)
        # فایل‌های صفحه‌ی موفق نباید به‌خاطر وقفه دور ریخته شوند.
        self.assertEqual([f.file_name for f in result.found], ["a.npvt", "b.npvt"])
        # دقیقاً دو واکشی: صفحه‌ی نخست و صفحه‌ی دومِ شکست‌خورده؛ صفحه‌ی سوم تلاش نشده.
        self.assertEqual(
            fetcher.calls,
            [page_url("ch"), page_url("ch", before=98)],
        )

    def test_empty_mid_page_is_natural_end_not_interruption(self):
        """صفحه‌ی میانی بدون پیام، پایان طبیعی تاریخچه است و وقفه محسوب نمی‌شود."""
        pages = {
            page_url("ch"): page_html([message_html("ch", 100, "a.npvt")]),
            page_url("ch", before=100): "<html><body><div></div></html>",
        }
        fetcher = ControlledFetcher(pages)
        with mock.patch.object(mod, "fetch_url", fetcher):
            result = mod.scan_channel("ch", 0)

        self.assertFalse(result.invalid)
        self.assertFalse(result.interrupted)
        self.assertIsNone(result.resume_after_id)
        self.assertEqual(result.newest_id, 100)

    def test_normal_full_walk_is_not_interrupted(self):
        """پیمایش کامل تا رسیدن به چک‌پوینت قبلی: رفتار قدیمی دست‌نخورده می‌ماند."""
        pages = {
            page_url("ch"): page_html([
                message_html("ch", 100, "a.npvt"),
                message_html("ch", 99, "b.npvt"),
            ]),
            # صفحه‌ی دوم پیامِ چک‌پوینت (80) را دارد → باید همین‌جا توقف شود.
            page_url("ch", before=99): page_html([
                message_html("ch", 90, "old.npvt"),       # 90 > 80: مثل رفتار قدیمی جمع می‌شود
                message_html("ch", 80, "at_checkpoint.npvt"),  # 80 <= 80: نادیده
            ]),
        }
        fetcher = ControlledFetcher(pages)
        with mock.patch.object(mod, "fetch_url", fetcher):
            result = mod.scan_channel("ch", 80)

        self.assertFalse(result.interrupted)
        self.assertFalse(result.invalid)
        self.assertEqual(result.newest_id, 100)
        # پیام ۸۰ (و قدیمی‌تر) نادیده گرفته می‌شود؛ ۹۰ همچنان بالای چک‌پوینت است.
        self.assertEqual(
            [f.file_name for f in result.found], ["a.npvt", "b.npvt", "old.npvt"]
        )
        # صفحه‌ی سوم نباید واکشی شود (به چک‌پوینت رسیده‌ایم).
        self.assertEqual(
            fetcher.calls,
            [page_url("ch"), page_url("ch", before=99)],
        )

    def test_blocked_keyword_file_filtered_even_during_interruption(self):
        """فایل صفحه‌ی موفق حتی در دورِ منقطع، فیلتر کلیدواژه می‌شود اما حذف نمی‌شود."""
        pages = {
            page_url("ch"): page_html([
                message_html("ch", 100, "ok.npvt"),
                message_html("ch", 99, "فایل پهلوی.npvt"),  # کلیدواژه‌ی مسدود پیش‌فرض
            ]),
            page_url("ch", before=99): "",
        }
        fetcher = ControlledFetcher(pages, failing_urls={page_url("ch", before=99)})
        with mock.patch.object(mod, "fetch_url", fetcher):
            result = mod.scan_channel("ch", 50)

        self.assertTrue(result.interrupted)
        self.assertEqual([f.file_name for f in result.found], ["ok.npvt"])
        self.assertEqual(len(result.filtered), 1)
        self.assertEqual(result.filtered[0][0], "فایل پهلوی.npvt")


class DecideCheckpointTests(unittest.TestCase):
    def test_invalid_channel_keeps_old_checkpoint(self):
        self.assertEqual(mod.decide_checkpoint(80, 100, True, False, None), 80)

    def test_interrupted_keeps_value_that_recovers_the_gap(self):
        # مرز 98 گزارش شده، اما چون صفحه‌ی شکست‌خورده خوانده نشده و شماره‌ی
        # پیام‌ها می‌تواند گاف داشته باشد، هیچ مقداری بالاتر از last_id تضمین
        # پیوستگی ندارد؛ چک‌پوینت باید روی 80 بماند تا کل شکاف بازخوانی شود.
        self.assertEqual(mod.decide_checkpoint(80, 100, False, True, 98), 80)
        self.assertEqual(mod.decide_checkpoint(70, 100, False, True, 92), 70)
        # بدون مرز شناخته‌شده هم باز چک‌پوینت قبلی نگه داشته می‌شود.
        self.assertEqual(mod.decide_checkpoint(80, 100, False, True, None), 80)

    def test_normal_scan_advances_to_newest(self):
        self.assertEqual(mod.decide_checkpoint(80, 100, False, False, None), 100)
        # اگر پیام جدیدی نبود، مقدار قدیمی کم نمی‌شود.
        self.assertEqual(mod.decide_checkpoint(80, 80, False, False, None), 80)


# ----------------------------------------------------------------------------
# تست یکپارچه‌ی main(): دو دور اجرا، شکاف در دور بعد بازخوانی می‌شود
# ----------------------------------------------------------------------------
class MainResumableRunTests(unittest.TestCase):
    CHANNEL = "testchan"
    DEAD_CHANNEL = "deadchan"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)

        self.channels_file = self.tmp_path / "channels.txt"
        self.checkpoint_file = self.tmp_path / "last_message_id.json"
        self.seen_file = self.tmp_path / "seen_files.json"
        self.report_file = self.tmp_path / "npvt_report.txt"
        self.channel_report_file = self.tmp_path / "channel_report.txt"
        self.invalid_file = self.tmp_path / "invalid_channels.txt"
        self.pending_file = self.tmp_path / "pending_send.json"
        self.filtered_file = self.tmp_path / "filtered_files.txt"
        self.blocked_file = self.tmp_path / "blocked_keywords.txt"

        self.channels_file.write_text(f"{self.CHANNEL}\n{self.DEAD_CHANNEL}\n", encoding="utf-8")
        self.checkpoint_file.write_text(
            json.dumps({self.CHANNEL: 80, self.DEAD_CHANNEL: 5}), encoding="utf-8"
        )
        self.seen_file.write_text("{}", encoding="utf-8")
        # فایل کلیدواژه‌های مسدود خالی (فقط یک خط توضیح) تا فیلتر پیش‌فرض
        # از فایل واقعیِ مخزن به این تست نشت نکند.
        self.blocked_file.write_text("# تست\n", encoding="utf-8")

        # ---- صفحه‌های مشترک هر دو دور ----
        # صفحه‌ی نخست: 100 (a.npvt)، 99 (پیام ساده)، 98 (b.npvt)
        self.page1 = page_url(self.CHANNEL)
        # صفحه‌ی دوم (؟before=98): 97 (c.npvt)، 96 ساده، 95 (d.npvt)
        self.page2 = page_url(self.CHANNEL, before=98)
        # صفحه‌ی سوم (؟before=95): 94 (e.npvt، فایل قدیمیِ لای شکاف)
        self.page3 = page_url(self.CHANNEL, before=95)
        self.pages = {
            self.page1: page_html([
                message_html(self.CHANNEL, 100, "a.npvt", "1.0 MB"),
                message_html(self.CHANNEL, 99),
                message_html(self.CHANNEL, 98, "b.npvt", "2.0 MB"),
            ]),
            self.page2: page_html([
                message_html(self.CHANNEL, 97, "c.npvt", "3.0 MB"),
                message_html(self.CHANNEL, 96),
                message_html(self.CHANNEL, 95, "d.npvt", "4.0 MB"),
            ]),
            self.page3: page_html([
                message_html(self.CHANNEL, 94, "e.npvt", "5.0 MB"),
                message_html(self.CHANNEL, 93),
                message_html(self.CHANNEL, 92),
            ]),
        }

        self._patches = [
            mock.patch.object(mod, "CHANNELS_FILE", self.channels_file),
            mock.patch.object(mod, "CHECKPOINT_FILE", self.checkpoint_file),
            mock.patch.object(mod, "SEEN_FILES_FILE", self.seen_file),
            mock.patch.object(mod, "REPORT_FILE", self.report_file),
            mock.patch.object(mod, "CHANNEL_REPORT_FILE", self.channel_report_file),
            mock.patch.object(mod, "INVALID_CHANNELS_FILE", self.invalid_file),
            mock.patch.object(mod, "PENDING_FILE", self.pending_file),
            mock.patch.object(mod, "FILTERED_FILES_FILE", self.filtered_file),
            mock.patch.object(mod, "BLOCKED_KEYWORDS_FILE", self.blocked_file),
            mock.patch.object(mod, "BLOCKED_KEYWORDS", []),
            mock.patch.object(mod, "BOT_TOKEN", "test-token"),
            mock.patch.object(mod, "TARGET_CHANNEL", "@test_target"),
            mock.patch.object(mod, "MAX_PAGES_PER_CHANNEL", 3),
            mock.patch.object(mod.time, "sleep", lambda *a, **kw: None),
        ]
        for p in self._patches:
            p.start()

        # ارسال تلگرام به‌جای شبکه: همیشه موفق، با شمارش پیام‌های ارسالی.
        self.sent_messages: list[str] = []
        self.send_patch = mock.patch.object(
            mod, "send_telegram_message",
            side_effect=lambda text, parse_mode="HTML": self.sent_messages.append(text) or True,
        )
        self.send_patch.start()

    def tearDown(self):
        self.send_patch.stop()
        for p in self._patches:
            p.stop()
        self.tmp.cleanup()

    def _read_checkpoints(self) -> dict:
        return json.loads(self.checkpoint_file.read_text(encoding="utf-8"))

    def _read_seen(self) -> dict:
        return json.loads(self.seen_file.read_text(encoding="utf-8"))

    def _report_lines(self) -> list[str]:
        return [
            line.strip()
            for line in self.report_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def test_interruption_keeps_checkpoint_and_next_round_refills_gap(self):
        # ============ دور نخست: صفحه‌ی دوم شکست می‌خورد ============
        fetcher_round1 = ControlledFetcher(
            self.pages, failing_urls={self.page2}
        )
        with mock.patch.object(mod, "fetch_url", fetcher_round1):
            mod.main()

        # 1) فقط صفحه‌ی نخست و صفحه‌ی دومِ شکست‌خورده واکشی شده‌اند؛
        #    صفحه‌ی سوم (که لای شکاف است) اصلاً تلاش نشده.
        self.assertEqual(
            fetcher_round1.calls,
            [
                self.page1,
                self.page2,
                page_url(self.DEAD_CHANNEL),  # کانال دوم: صفحه‌ی نخستش هم شکست می‌خورد
            ],
        )

        # 2) چک‌پوینت testchan جلو نرفته (روی 80 مانده) تا شکاف تضمیناً بازخوانی شود.
        checkpoints_1 = self._read_checkpoints()
        self.assertEqual(checkpoints_1[self.CHANNEL], 80)
        # کانال نامعتبر هم چک‌پوینت قبلی‌اش دست‌نخورده مانده.
        self.assertEqual(checkpoints_1[self.DEAD_CHANNEL], 5)

        # 3) فایل‌های صفحه‌ی موفق دور نخست (a و b) ارسال و در seen_files ثبت شده‌اند.
        seen_1 = self._read_seen()
        self.assertEqual(
            sorted(data["file_name"] for data in seen_1.values()),
            ["a.npvt", "b.npvt"],
        )
        # دو پیام تلگرام: هدر + فهرست (فهرست به پیام‌های مبدأ لینک می‌شود).
        self.assertEqual(len(self.sent_messages), 2)
        self.assertEqual(self.sent_messages[0], mod.HEADER_TEXT)
        self.assertIn(f"https://t.me/{self.CHANNEL}/100", self.sent_messages[1])
        self.assertIn(f"https://t.me/{self.CHANNEL}/98", self.sent_messages[1])

        # 4) گزارش دور نخست: فیلد جدید وقفه‌ی صفحه‌بندی دیده می‌شود و
        #    فیلدهای قدیمی همچنان سر جای خودشان هستند.
        report_1 = self._report_lines()[-1]
        for old_field in [
            "found=", "duplicates=", "already_sent=", "batch=", "sent=",
            "failed=", "discarded=", "pending_retry=", "filtered=",
            "invalid_channels=",
        ]:
            self.assertIn(old_field, report_1)
        self.assertIn("page_interrupted=1", report_1)
        self.assertIn("interrupted_count=1", report_1)
        self.assertIn(f"interrupted_channels={self.CHANNEL}", report_1)
        self.assertIn("invalid_channels=1", report_1)

        # 5) کانال مرده در فهرست کانال‌های نامعتبر و گزارش کانال‌ها با ERR آمده.
        invalid_text = self.invalid_file.read_text(encoding="utf-8")
        self.assertIn(self.DEAD_CHANNEL, invalid_text)
        channel_report_text = self.channel_report_file.read_text(encoding="utf-8")
        self.assertIn(f"{self.DEAD_CHANNEL}: ERR", channel_report_text)

        # ============ دور دوم: خطا برطرف شده، همان صفحات در دسترس‌اند ============
        fetcher_round2 = ControlledFetcher(self.pages, failing_urls=set())
        with mock.patch.object(mod, "fetch_url", fetcher_round2):
            mod.main()

        # 6) دور بعد واقعاً صفحه‌ی دوم و سوم (شکاف) را دوباره واکشی کرده است.
        self.assertIn(self.page2, fetcher_round2.calls)
        self.assertIn(self.page3, fetcher_round2.calls)
        self.assertEqual(fetcher_round2.calls[0], self.page1)

        # 7) فایل‌های قدیمیِ شکاف (c, d, e) این دور پیدا و ارسال شده‌اند؛
        #    a و b به‌خاطر seen_files دوباره ارسال نمی‌شوند.
        seen_2 = self._read_seen()
        self.assertEqual(
            sorted(data["file_name"] for data in seen_2.values()),
            ["a.npvt", "b.npvt", "c.npvt", "d.npvt", "e.npvt"],
        )
        # دور دوم هم دو پیام فرستاده (هدر + فهرستِ c/d/e).
        self.assertEqual(len(self.sent_messages), 4)

        # 8) حالا که پوشش پیوسته کامل شد، چک‌پوینت تا جدیدترین پیام جلو رفته.
        checkpoints_2 = self._read_checkpoints()
        self.assertEqual(checkpoints_2[self.CHANNEL], 100)

        # 9) گزارش دور دوم نباید وقفه نشان دهد (فیلد جدید با مقدار صفر/خط‌تیره).
        report_2 = self._report_lines()[-1]
        self.assertIn("page_interrupted=0", report_2)
        self.assertIn("interrupted_count=0", report_2)
        self.assertIn("interrupted_channels=-", report_2)
        # a و b به‌عنوان «قبلاً ارسال‌شده» در آمار همین خط دیده می‌شوند.
        self.assertIn("already_sent=2", report_2)
        self.assertIn("sent=3", report_2)

        # 10) صف ارسال شکست‌خورده‌ای باقی نمانده.
        self.assertEqual(json.loads(self.pending_file.read_text(encoding="utf-8")), {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
