declare module 'troika-three-text' {
  import { Mesh } from 'three';

  export class Text extends Mesh {
    text: string;
    font: string | null;
    fontSize: number;
    sync(callback?: () => void): void;
    dispose(): void;
  }

  export function configureTextBuilder(options: { defaultFontURL?: string; useWorker?: boolean }): void;
}
