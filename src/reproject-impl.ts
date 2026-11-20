import { reprojectTexture as engineReprojectTexture } from 'playcanvas';
import type { Texture } from 'playcanvas';

type ReprojectOptions = NonNullable<Parameters<typeof engineReprojectTexture>[2]>;
type ReprojectFn = (source: Texture, target: Texture, options?: ReprojectOptions) => boolean;

// indirection so the acceptance harness can force a failure to exercise the
// panel's catch/cleanup/error path; production behavior is identical
let impl: ReprojectFn = engineReprojectTexture;

function reproject(source: Texture, target: Texture, options?: ReprojectOptions): boolean {
    return impl(source, target, options);
}

// pass null to restore the real engine implementation
function setReprojectImpl(next: ReprojectFn | null): void {
    impl = next || engineReprojectTexture;
}

export { reproject, setReprojectImpl };
