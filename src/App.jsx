import React from 'react';
import './App.css';
import { Header } from './components/Header';
import { PlantSvg } from './components/PlantSvg';
import { WaterDroplets } from './components/WaterDroplets';
import { FinalCard } from './components/FinalCard';
import { ParticleCanvas } from './components/ParticleCanvas';
import { useFlowerStage } from './hooks/useFlowerStage';

export function App() {
  const {
    currentStage,
    stage,
    showModal,
    bloomSunflower,
    dropsKey,
    showRipple,
    triggerBurst,
    isPending,
    handleWater,
    handleRevealFlower,
  } = useFlowerStage();

  return (
    <>
      <div className="background-decorations">
        <div className="bg-sun-glow"></div>
      </div>

      <ParticleCanvas triggerBurst={triggerBurst} />

      <main className="app-container">
        <Header
          showTitle={stage.showTitle}
          reasons={stage.reasons}
          showSpecial={stage.showSpecial}
        />

        <section className="plant-section">
          <WaterDroplets dropsKey={dropsKey} showRipple={showRipple} />
          <PlantSvg
            stage={currentStage}
            stemHeight={stage.stemHeight}
            visibleLeaves={stage.visibleLeaves}
            bloomSunflower={bloomSunflower}
          />
        </section>

        <FinalCard
          show={showModal}
          onRevealFlower={handleRevealFlower}
        />

        <footer className="footer-section">
          <button
            type="button"
            className="water-button"
            onClick={handleWater}
            disabled={isPending}
            aria-busy={isPending}
          >
            <span>{bloomSunflower ? "Floreció" : stage.btnText}</span>
            <span className="btn-emoji">{bloomSunflower ? "💛" : stage.btnEmoji}</span>
          </button>
        </footer>
      </main>
    </>
  );
}

export default App;
