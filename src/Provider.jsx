import {
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from 'react'
import { sequenceList, soundFiles } from './constants/config'
import SoundEngine from './engine/SoundEngine'
import Transport from './engine/Transport'
import AppContext from './context'

const withSoundPaths = (trackList) =>
    trackList.map((track) => ({
        ...track,
        soundFilePath: soundFiles[track.soundFile],
    }))

const appReducer = (state, action) => {
    switch (action.type) {
        case 'SET_SEQUENCE':
            return { ...sequenceList.find((seq) => seq.id === action.value) }
        case 'SET_ON_NOTES':
            return {
                ...state,
                trackList: state.trackList.map((track, trackID) =>
                    action.trackID === trackID
                        ? { ...track, onNotes: action.value }
                        : track
                ),
            }
        default:
            return state
    }
}

const Provider = ({ children }) => {
    const [sequence, dispatch] = useReducer(appReducer, {
        ...sequenceList[0],
    })
    const [bpm, setBpmState] = useState(120)
    const [frame, setFrame] = useState(null)

    // The engine lives outside React render state: React only mirrors the
    // snapshots it emits on every animation frame.
    const transportRef = useRef(null)
    if (transportRef.current === null) {
        transportRef.current = new Transport({
            soundEngine: new SoundEngine(),
        })
    }
    const transport = transportRef.current

    useEffect(() => {
        const unsubscribe = transport.subscribe(setFrame)
        return unsubscribe
    }, [transport])

    // Sequence switch (and first mount): every track slot reloads its
    // soundFile through the sound engine. The playhead is untouched.
    useEffect(() => {
        transport.loadSequence(withSoundPaths(sequence.trackList))
    }, [transport, sequence.id]) // eslint-disable-line react-hooks/exhaustive-deps

    // Note edits only swap the pattern; loaded samples stay valid.
    useEffect(() => {
        transport.updateTracks(withSoundPaths(sequence.trackList))
    }, [transport, sequence.trackList])

    const toggleNote = ({ trackID, stepID }) => {
        const onNotes = sequence.trackList[trackID].onNotes
        const newOnNotes =
            onNotes.indexOf(stepID) === -1
                ? [...onNotes, stepID]
                : onNotes.filter((col) => col !== stepID)
        dispatch({ type: 'SET_ON_NOTES', value: newOnNotes, trackID })
    }

    const selectSequence = (sequenceID) => {
        dispatch({ type: 'SET_SEQUENCE', value: sequenceID })
    }

    const setBPM = (value) => {
        const parsed = Number(value)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return
        }
        setBpmState(parsed)
        transport.setBPM(parsed)
    }

    const value = useMemo(
        () => ({
            sequence,
            bpm,
            frame,
            toggleNote,
            selectSequence,
            setBPM,
            play: () => transport.play(),
            pause: () => transport.pause(),
            stop: () => transport.stop(),
            preview: (trackID) => transport.preview(trackID),
        }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [sequence, bpm, frame, transport]
    )

    return (
        <AppContext.Provider value={value}>{children}</AppContext.Provider>
    )
}

export { Provider }
