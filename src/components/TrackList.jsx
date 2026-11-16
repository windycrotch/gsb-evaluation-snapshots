import { useContext, memo } from "react";
import AppContext from "../context";
import Track from "./Track";

const TrackList = ({ currentStepID }) => {
  const {
    sequence: { trackList, noteCount },
  } = useContext(AppContext);

  const content = trackList.map((track, trackID) => {
    const { title, onNotes } = track;

    return (
      <Track
        // Include the track index in the key so a sequence switch remounts
        // each track and its UI state is rebuilt from the new pattern.
        key={`${title}-${trackID}`}
        trackID={trackID}
        currentStepID={currentStepID}
        title={title}
        noteCount={noteCount}
        onNotes={onNotes}
      />
    );
  });

  return <div className="track-list">{content}</div>;
};

export default memo(TrackList);
