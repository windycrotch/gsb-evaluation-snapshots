import { fromFile } from '../scan-folder';
import type { ScanFolderPicker } from './types';

function pickFile(
  targetDocument: Document,
  accept: string,
): Promise<File | null> {
  return new Promise((resolve) => {
    const input = targetDocument.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;

    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null), {
      once: true,
    });
    input.addEventListener('cancel', () => finish(null), { once: true });

    targetDocument.body.append(input);
    input.click();
  });
}

export function createFileUploadPicker(
  targetDocument: Document,
  accept = '',
): ScanFolderPicker {
  return {
    supported: true,
    async pickSource() {
      const file = await pickFile(targetDocument, accept);
      return file ? fromFile(file) : null;
    },
  };
}
