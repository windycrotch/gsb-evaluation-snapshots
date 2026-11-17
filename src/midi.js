// Web MIDI input: lets a hardware controller drive transport and knobs.
// Works on a secure context (https or localhost / 127.0.0.1).

export async function initMidi({ onMessage, onStatus }) {
  if (!navigator.requestMIDIAccess) {
    onStatus?.("Web MIDI non supportato da questo browser.");
    return null;
  }
  try {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    const attach = () => {
      const names = [];
      for (const input of access.inputs.values()) {
        input.onmidimessage = onMessage;
        names.push(input.name);
      }
      onStatus?.(names.length ? `Connesso: ${names.join(", ")}` : "Attivo, nessun dispositivo collegato.");
    };
    access.onstatechange = attach;
    attach();
    return access;
  } catch (error) {
    onStatus?.(`Accesso MIDI negato: ${error?.message ?? error}`);
    return null;
  }
}

// Decode a raw MIDI message into a stable id (for binding) + a human label.
export function describeMessage(data) {
  const [status, d1, d2] = data;
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;

  if (type === 0x90 && d2 > 0) {
    return { kind: "note", id: `note:${d1}`, label: `Nota ${d1} · ch${channel}`, value: d2 };
  }
  if (type === 0x80 || (type === 0x90 && d2 === 0)) {
    return { kind: "noteoff", id: `note:${d1}`, label: `Nota ${d1} off`, value: 0 };
  }
  if (type === 0xb0) {
    return { kind: "cc", id: `cc:${d1}`, label: `CC ${d1} · ch${channel}`, value: d2 };
  }
  return null;
}
