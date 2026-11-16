"""
roundtrip_check.py

Builds local SCTE-35 sample cues and verifies the conversion
round trip used by ops when checking ad-insertion markers:

    base64 -> Cue -> hex -> Cue -> int -> Cue -> bytes -> Cue -> base64

For every sample, the splice command type, the command time
fields, the descriptor count, and every descriptor's
segmentation_type_id and segmentation_duration must survive
each conversion unchanged.

It also verifies that:
  * decoding then encoding the same cue twice yields byte
    identical base64 (no pts_adjustment or descriptor
    length drift),
  * the encoded crc and section_length match the actual bytes,
  * invalid inputs (truncated base64, bytes not starting with
    0xfc, an unknown splice command type) are rejected with a
    clear failure result (decode()/encode() return False,
    Cue.command is None) instead of raising an uncaught
    exception or producing a seemingly valid encoding.

run:  python examples/roundtrip_check.py
"""

import sys

from threefive import Cue, TimeSignal, SpliceInsert
from threefive.crc import crc32
from threefive.descriptors import SegmentationDescriptor

FAILURES = []


def check(label, ok):
    """
    check prints PASS/FAIL for one assertion
    and records failures for the exit code.
    """
    status = ("FAIL", "PASS")[bool(ok)]
    print(f"  [{status}] {label}")
    if not ok:
        FAILURES.append(label)


def mk_segmentation_descriptor():
    """
    mk_segmentation_descriptor builds a local
    Segmentation Descriptor sample:
    Provider Advertisement Start, 120.0 seconds.
    """
    segd = SegmentationDescriptor()
    segd.segmentation_event_id = "0x4800008e"
    segd.segmentation_event_cancel_indicator = False
    segd.segmentation_event_id_compliance_indicator = True
    segd.program_segmentation_flag = True
    segd.segmentation_duration_flag = True
    segd.delivery_not_restricted_flag = True
    segd.segmentation_duration = 120.0
    segd.segmentation_upid_type = 0
    segd.segmentation_upid_length = 0
    segd.segmentation_type_id = 0x30  # Provider Advertisement Start
    segd.segment_num = 1
    segd.segments_expected = 1
    return segd


def mk_time_signal_with_descriptor():
    """
    Time Signal + Segmentation Descriptor,
    with a non-zero pts_adjustment to catch drift.
    """
    cue = Cue()
    cue.command = TimeSignal()
    cue.command.time_specified_flag = True
    cue.command.pts_time = 21695.740089
    cue.descriptors = [mk_segmentation_descriptor()]
    cue.info_section.pts_adjustment = 45.5
    return cue.encode()


def mk_time_signal_only():
    """
    A bare Time Signal cue, no descriptors.
    """
    cue = Cue()
    cue.command = TimeSignal()
    cue.command.time_specified_flag = True
    cue.command.pts_time = 44123.587711
    return cue.encode()


def mk_splice_insert_with_descriptor():
    """
    Splice Insert + Segmentation Descriptor,
    the classic live ad-break marker.
    """
    cue = Cue()
    cue.command = SpliceInsert()
    cue.command.splice_event_id = 0x4800008E
    cue.command.splice_event_cancel_indicator = False
    cue.command.out_of_network_indicator = True
    cue.command.program_splice_flag = True
    cue.command.duration_flag = True
    cue.command.splice_immediate_flag = False
    cue.command.event_id_compliance_flag = True
    cue.command.time_specified_flag = True
    cue.command.pts_time = 21695.740089
    cue.command.break_auto_return = True
    cue.command.break_duration = 120.0
    cue.command.unique_program_id = 1
    cue.command.avail_num = 1
    cue.command.avails_expected = 1
    cue.descriptors = [mk_segmentation_descriptor()]
    return cue.encode()


# A known-good external sample: Time Signal + Segmentation
# Descriptor (Provider Placement Opportunity End, type 0x35).
CLASSIC_B64 = "/DAvAAAAAAAA///wBQb+dGKQoAAZAhdDVUVJSAAAjn+fCAgAAAAALKChijUCAKnMZ1g="

SAMPLES = {
    "time signal + segmentation descriptor": mk_time_signal_with_descriptor(),
    "time signal only": mk_time_signal_only(),
    "splice insert + segmentation descriptor": mk_splice_insert_with_descriptor(),
    "classic external time signal": CLASSIC_B64,
}


def snapshot(cue):
    """
    snapshot extracts the fields that must survive
    every conversion: command type, command time fields,
    descriptor count, and per-descriptor
    segmentation_type_id / segmentation_duration.
    """
    return {
        "command": cue.command.get(),
        "descriptors": [
            {
                "segmentation_type_id": d.segmentation_type_id,
                "segmentation_duration": d.segmentation_duration,
            }
            for d in cue.descriptors
        ],
    }


def check_crc_and_length(cue):
    """
    check_crc_and_length verifies the encoded crc and
    section_length match the actual encoded bytes.
    """
    bites = cue.bytes()
    section_length_ok = cue.info_section.section_length == len(bites) - 3
    crc_ok = crc32(bites[:-4]) == int(cue.info_section.crc, 16)
    return section_length_ok, crc_ok


def roundtrip_sample(name, b64):
    """
    roundtrip_sample runs one sample cue through
    base64 -> hex -> int -> bytes -> base64 and
    verifies nothing is lost or mangled.
    """
    print(f"sample: {name}")
    orig = Cue(b64)
    check("decodes", orig.command is not None)
    want = snapshot(orig)

    # same cue decoded -> encoded twice must be identical
    first = orig.encode()
    second = orig.encode()
    check("decode->encode is stable (no drift)", first == second == b64)

    # crc and section_length match the actual bytes
    sl_ok, crc_ok = check_crc_and_length(orig)
    check("section_length matches actual bytes", sl_ok)
    check("crc matches actual bytes", crc_ok)

    # base64 -> hex -> Cue
    as_hex = orig.hex()
    check("hex encodes", isinstance(as_hex, str) and as_hex.startswith("0xfc"))
    from_hex = Cue(as_hex)
    check("hex -> Cue keeps command and descriptors", snapshot(from_hex) == want)

    # hex -> int -> Cue
    as_int = from_hex.int()
    check("int encodes", isinstance(as_int, int) and as_int > 0)
    from_int = Cue(as_int)
    check("int -> Cue keeps command and descriptors", snapshot(from_int) == want)

    # int -> bytes -> Cue
    as_bytes = from_int.bytes()
    check("bytes encodes", isinstance(as_bytes, bytes) and as_bytes[0] == 0xFC)
    from_bytes = Cue(as_bytes)
    check("bytes -> Cue keeps command and descriptors", snapshot(from_bytes) == want)

    # bytes -> base64, and the chain closes on the original
    final_b64 = from_bytes.encode()
    check("round trip returns the original base64", final_b64 == b64)

    # the re-parsed cue is itself stable under decode->encode
    check("re-parsed cue is stable", Cue(final_b64).encode() == b64)
    print()


def expect_rejected(name, data):
    """
    expect_rejected verifies an invalid input fails
    cleanly: no exception, Cue.command is None, and
    every encoder returns False.
    """
    print(f"invalid input: {name}")
    try:
        cue = Cue(data)
    except Exception as exc:  # pylint: disable=broad-except
        check("constructor does not raise", False)
        print(f"    raised {type(exc).__name__}: {exc}")
        return
    check("constructor does not raise", True)
    check("decode reports failure", cue.decode() is False)
    check("command is None", cue.command is None)
    check("get() is False", cue.get() is False)
    check("base64() is False", cue.base64() is False)
    check("encode() is False", cue.encode() is False)
    check("bytes() is False", cue.bytes() is False)
    check("hex() is False", cue.hex() is False)
    check("int() is False", cue.int() is False)
    print()


def main():
    """
    main runs all round trip and rejection checks.
    """
    print("== round trip: base64 -> hex -> int -> bytes -> base64 ==\n")
    for name, b64 in SAMPLES.items():
        roundtrip_sample(name, b64)

    print("== invalid inputs are rejected ==\n")
    # truncated base64: valid cue cut off mid-descriptor
    expect_rejected("truncated base64", CLASSIC_B64[:40])
    # bytes that do not start with the 0xfc table id
    expect_rejected("non-0xfc bytes", b"\x00\x11\x22\x33" * 8)
    # a valid cue with an unknown splice command type (0x99)
    bogus = bytearray(Cue(CLASSIC_B64).bytes())
    bogus[13] = 0x99  # splice_command_type byte of the info section
    expect_rejected("unknown splice command type", bytes(bogus))

    if FAILURES:
        print(f"{len(FAILURES)} check(s) FAILED")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
