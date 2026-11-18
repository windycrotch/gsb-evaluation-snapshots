### Installation
```shell
pip install tkvideoplayer
```

### Quickstart

```py
import tkinter as tk
from tkVideoPlayer import TkinterVideo

root = tk.Tk()

videoplayer = TkinterVideo(master=root, scaled=True)
videoplayer.load(r"samplevideo.mp4")
videoplayer.pack(expand=True, fill="both")

videoplayer.play() # play the video

root.mainloop()
```
read additional examples [here](https://github.com/PaulleDemon/tkVideoPlayer/tree/master/examples)

### Methods
TkVideoPlayer inherits from `tk.Label` and display's the image on the label.

Below are the methods of this library.

| Methods          | Parameters                           | Description                                                                                                                                                                                   |
|------------------|--------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| \_\_init\_\_     | scaled(bool), consistant_frame_rate(bool)=True, keep_aspect(bool)=False   | The scale parameter scales the video to the label size.  The consistant_frame_rate parameter skips frames to keep the framerate consistant and keep_aspect keeps aspect ratio when resizing(note: It will not increase the size)       |
| set_scaled       | scaled(bool), keep_aspect(bool)=False                         | scales the video to the label size.                                                                                                                                                           |
| load             | file_path(str)                       | starts loading the video in a thread. The file is opened (and `<<Loaded>>`/`<<Duration>>` are generated, with the first frame displayed) immediately, while the video stays paused until `play()` is called. |
| set_size         | size(Tuple[int, int]), keep_aspect(bool)=False | sets the size of the video frame. setting this will set scaled to `False`                                                                                                                     |
| current_duration  | -                                    | returns the current position in seconds. After the video ends it returns the full duration.                                                                                                    |
| video_info       | -                                    | returns dictionary containing framerate, framesize, duration.|
| play             | -                                    | Plays the video. Calling it after the video has ended restarts from the beginning.                                                                                                             |
| pause            | -                                    | Pauses the video                                                                                                                                                                              |
| is_paused        | -                                    | returns if the video is currently paused.                                                                                                                                               
| stop             | -                                    | stops playing the file, closes the file.  |
| seek             | sec(int)                             | moves to the given timestamp in seconds. The seek is applied even while paused, so the displayed frame and `current_duration()` follow immediately. Values are clamped to `[0, duration]`, so negative or too-large timestamps do not raise.                                           
| keep_aspect             | keep_aspect(bool)                            | keeps aspect ratio when resizing                                          
| metadata         | -                                    | returns meta information of the video if available in the form of dictionary                                           
| set_resampling_method|  method(int)                                   | By default the resampling method while resizing is NEAREST, changing this can affect how its resampled when image is resized, refer PIL documentation to read more (note: this can also affect the framerate of the video)|

### Virtual events

This are events that can be binded to get your desired results

| Virtual event          | Description                                                                                                         |
|------------------------|---------------------------------------------------------------------------------------------------------------------|
| <<Loaded\>\>       | This event is generated when the video file is opened (now fired by `load()`, before `play()`).                     |
| <<Duration\>\>       | This event is generated when the video duration is found.                                                           |
| <<SecondChanged\>\>  | This event is generated whenever a second in the video passes (calculated using frame_number%frame_rate==0).        |
| <<FrameGenerated\>\> | This event is generated whenever there is a new frame available. (internal use, don't use this unless you want to). |
| <<Ended\>\>          | This event is generated only when the video has ended. The player stays paused at the end; calling `play()` from the handler (or later) replays from the start. |

<sub> 

note:

If you would like to draw on the video etc. Copy/fork the repo and instead of inheriting from Label inherit from Canvas.
And use `image_id = self.create_image()` use the image_id to update the image.

</sub>

