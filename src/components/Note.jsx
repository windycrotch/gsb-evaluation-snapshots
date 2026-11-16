import { useContext, memo } from "react";
import classNames from "classnames";
import AppContext from "../context";
import "./Note.css";

const Note = ({ trackID, stepID, isNoteOn, isNoteOnCurrentStep }) => {
  const { toggleNote, preview } = useContext(AppContext);

  const noteClassNames = classNames("note", {
    on: isNoteOn,
    playing: isNoteOn && isNoteOnCurrentStep,
  });

  // Clicking a cell toggles the note and auditions the track's sample
  // immediately. Playback-triggered sounds come from the Transport engine,
  // not from a React effect, so highlight and sound can never drift apart.
  const noteClicked = (e) => {
    e.preventDefault();
    toggleNote({ trackID, stepID });
    preview(trackID);
  };

  return <div className={noteClassNames} onClick={noteClicked} />;
};

export default memo(Note);
