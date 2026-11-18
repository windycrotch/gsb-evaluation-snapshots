"""User-facing backend messages in the request language.

The language comes from the ``X-Impasto-Lang`` header (the web UI always sends it) or the
``Accept-Language`` header. Errors raised in background threads (MQTT callbacks) store a
message key and are translated when the status is read in a request.
"""
from __future__ import annotations

from contextvars import ContextVar

LANG: ContextVar[str] = ContextVar("impasto_lang", default="en")

MESSAGES: dict[str, dict[str, str]] = {
    "error.file_not_found": {"de": "Datei nicht gefunden", "en": "File not found"},
    "error.empty_file": {"de": "leere Datei", "en": "empty file"},
    "error.bad_3mf": {"de": "Kein gültiges 3MF", "en": "Not a valid 3MF"},
    "error.3mf_no_gcode": {
        "de": "Das 3MF enthält keinen G-Code – bitte in Bambu Studio slicen und als .gcode.3mf exportieren.",
        "en": "The 3MF contains no G-code – slice it in Bambu Studio and export it as .gcode.3mf.",
    },
    "error.not_gcode": {"de": "Das sieht nicht nach G-Code aus.",
                        "en": "This does not look like G-code."},
    "error.no_paths": {"de": "Keine Linien – erst etwas auf die Fläche legen.",
                       "en": "No lines – place something on the surface first."},
    "error.generate_failed": {"de": "Generierung fehlgeschlagen: {ex}",
                              "en": "Generation failed: {ex}"},
    "error.head_unknown": {"de": "Druckkopf {head} unbekannt.",
                           "en": "Print head {head} unknown."},
    "error.head_unknown_short": {"de": "Druckkopf unbekannt.", "en": "Print head unknown."},
    "error.no_result": {"de": "Erst G-Code erzeugen.", "en": "Generate the G-code first."},
    "error.ip_code_required": {"de": "IP und Access Code nötig",
                               "en": "IP and access code required"},
    "error.access_rejected": {
        "de": "Access Code abgelehnt – aktuellen Code am Drucker ablesen "
              "(Einstellungen → WLAN → Access Code) und neu eintragen.",
        "en": "Access code rejected – read the current code from the printer "
              "(Settings → WLAN → Access Code) and enter it again.",
    },
    "error.ftps": {"de": "FTPS: {msg}", "en": "FTPS: {msg}"},
    "error.printer_not_configured": {"de": "Drucker nicht konfiguriert (IP + Access Code).",
                                     "en": "Printer not configured (IP + access code)."},
    "error.printer_not_set_up": {"de": "Drucker nicht konfiguriert",
                                 "en": "Printer not configured"},
    "error.serial_unknown": {
        "de": "Seriennummer unbekannt – im Drucker-Bereich TESTEN und erneut senden.",
        "en": "Serial number unknown – run TEST in the printer section and send again.",
    },
    "error.ams_unreadable": {"de": "AMS nicht lesbar: {ex}", "en": "AMS not readable: {ex}"},
    "error.upload_failed": {"de": "Upload fehlgeschlagen: {ex}", "en": "Upload failed: {ex}"},
    "error.name_missing": {"de": "Name fehlt", "en": "Name missing"},
    "error.variant_not_found": {"de": "Variante nicht gefunden", "en": "Variant not found"},
    "error.login_rejected": {
        "de": "Anmeldung am Drucker abgelehnt ({rc}) – Access Code prüfen",
        "en": "Login rejected by the printer ({rc}) – check the access code",
    },
    "error.mqtt_disconnected": {"de": "MQTT getrennt", "en": "MQTT disconnected"},
    "error.no_answer": {"de": "Keine Antwort vom Drucker – ist der LAN-Modus aktiv?",
                        "en": "No answer from the printer – is LAN mode enabled?"},
    "error.ams_not_read": {
        "de": "AMS nicht gelesen (kein Fach gemeldet). Im Drucker-Bereich TESTEN und erneut senden.",
        "en": "AMS not read (no tray reported). Run TEST in the printer section and send again.",
    },
    "error.ams_fewer": {
        "de": "{used} Filamente im G-Code, aber nur {trays} im AMS ({have}).",
        "en": "{used} filaments in the G-code, but only {trays} in the AMS ({have}).",
    },
    "error.plate_missing": {"de": "Platte {plate} nicht im 3MF (vorhanden: {plates})",
                            "en": "Plate {plate} not in the 3MF (available: {plates})"},
    "note.ams": {"de": "Filament {f} → AMS {slot} {type} {color}{extra}",
                 "en": "Filament {f} → AMS {slot} {type} {color}{extra}"},
    "note.ams_material": {"de": " (Material {type} statt {want})",
                          "en": " (material {type} instead of {want})"},
    "note.ams_color": {"de": " (Farbe {color} statt {want})",
                       "en": " (colour {color} instead of {want})"},
    "note.ams_both": {"de": " (Farbe und Material weichen ab: {type} {color})",
                      "en": " (colour and material differ: {type} {color})"},
    "common.none": {"de": "keine", "en": "none"},
}


def t(key: str, **kw) -> str:
    """Translate a message key into the current request language."""
    m = MESSAGES.get(key, {})
    s = m.get(LANG.get()) or m.get("en") or key
    return s.format(**kw) if kw else s


def language_from(headers) -> str:
    v = (headers.get("x-impasto-lang") or headers.get("x-npg-lang")
         or headers.get("accept-language") or "").strip().lower()
    return "de" if v.startswith("de") else "en"
