import ToolBar from "./components/Toolbar";
import Steps from "./components/Steps";
import TrackList from "./components/TrackList";
import PlayHead from "./components/PlayHead";
import { useAppContext } from "./context";
import useStyles from "./hooks/useStyles";
import { TOTAL_STEPS } from "./engine/Transport";
import "./Board.css";

function Board() {
  const { frame } = useAppContext();
  const [getNotesAreaWidthInPixels] = useStyles(TOTAL_STEPS);
  const notesAreaWidthInPixels = getNotesAreaWidthInPixels(TOTAL_STEPS);

  const currentStepID = frame ? frame.currentStepID : null;
  const progressInStep = frame ? frame.progressInStep : 0;
  const stepDuration = frame ? frame.stepDuration : 0;

  return (
    <main className="app">
      <header className="app_header">
        <h1 className="app_title">REACT 808 🎹</h1>
        <ToolBar />
      </header>
      <Steps count={TOTAL_STEPS} />
      <div className="app_content">
        <PlayHead
          notesAreaWidthInPixels={notesAreaWidthInPixels}
          currentStepID={currentStepID}
          progressInStep={progressInStep}
          totalSteps={TOTAL_STEPS}
          stepDuration={stepDuration}
        />
        <TrackList currentStepID={currentStepID} />
      </div>
      <footer className="app_footer">
        Source code on{" "}
        <a href="https://github.com/PLUSDEVLLC/react808.com">on Github</a>,
        Built by <a href="http://seifi.org/">Joe Seifi</a> using React.js
      </footer>
    </main>
  );
}

export default Board;
