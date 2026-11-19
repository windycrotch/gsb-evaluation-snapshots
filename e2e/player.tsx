import * as Slider from "@radix-ui/react-slider";
import { Fullscreen, Mute, PlayPause, Timestamp } from "@react-av/controls";
import * as Media from "@react-av/core";
import { ProgressBarBufferedRanges, ProgressBarRoot, VolumeRoot, useMediaProgressBarTooltip } from "@react-av/sliders";
import { StrictMode } from "react";
import { render } from "vitest-browser-react";
import clip from "./fixtures/clip.webm";

const sliderStyle = { display: "block", position: "relative", width: 200, height: 12 } as const;
const thumbStyle = { display: "block", width: 12, height: 12, background: "black" } as const;
const trackStyle = { display: "block", position: "relative", width: "100%", height: 12, background: "gray" } as const;
const rangeStyle = { display: "block", position: "absolute", height: "100%", background: "blue" } as const;
const bufferedStyle = { display: "block", position: "absolute", height: "100%", background: "lightgray" } as const;

/** Exposes the tooltip's hovered percentage so tests can assert it resets. */
function TooltipPercentageProbe() {
    const { percentage } = useMediaProgressBarTooltip();
    return <output data-testid="tooltip-percentage">{percentage}</output>;
}

/**
 * The test player keeps the progress bar's track mounted with a stable size and
 * exposes the buffered ranges, so pointer gestures and buffering can be driven
 * from tests.
 */
export async function renderPlayer(videoProps: Media.VideoProps = {}) {
    const screen = await render(
        <StrictMode>
            <Media.Root>
                <Media.Container>
                    <Media.Video src={clip} {...videoProps} />
                </Media.Container>
                <Media.Viewport>
                    <PlayPause />
                    <ProgressBarRoot style={sliderStyle} data-testid="seek-slider">
                        <Slider.Track style={trackStyle}>
                            <ProgressBarBufferedRanges data-testid="buffered" style={bufferedStyle} />
                            <Slider.Range style={rangeStyle} />
                        </Slider.Track>
                        <Slider.Thumb aria-label="Seek" style={thumbStyle} />
                        <TooltipPercentageProbe />
                    </ProgressBarRoot>
                    <Timestamp type="elapsed" />
                    <Mute />
                    <VolumeRoot style={sliderStyle}>
                        <Slider.Thumb aria-label="Volume" style={thumbStyle} />
                    </VolumeRoot>
                    <Fullscreen />
                </Media.Viewport>
            </Media.Root>
        </StrictMode>,
    );
    return screen.container.querySelector("video")!;
}
