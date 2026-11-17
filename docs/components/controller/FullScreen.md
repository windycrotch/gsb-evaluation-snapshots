# FullScreen

The FullScreen component manages entering and exiting fullscreen mode within the player. It supports the standardized Fullscreen API, as well as iOS-specific handling. A button in the controller area allows the user to toggle fullscreen.

## Configuration

Configuration example with defaults:

```javascript
const playerConfig = {
    fullScreen: {
        orientationLock: 'auto'
    }
};
```

| Setting Name        | Type             | Description                                                                                                                                                      |
| ------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orientationLock`   | String           | Controls screen orientation while in fullscreen. Values: `none` (no lock), `auto` (default, lock to landscape when the video is landscape and device is portrait), `landscape` (force landscape), `portrait` (force portrait). |

## API

The following API functions are added to the player instance to control the component:

| Method         | Arguments | Returns | Description         |
| ------------------ | ------------- | ----------- | ----------------------- |
| `fullscreen.enter` |               |             | Enters fullscreen mode. |
| `fullscreen.leave` |               |             | Exits fullscreen mode.  |

## State

The following properties are exposed to the players global `state.ui` object:

| State Name     | Type    | Description                                                                 |
|-----------------|---------|-----------------------------------------------------------------------------|
| `fullscreen`     | Boolean | Indicates whether the UI is in fullscreen.                              |


## Events

### Published own Events

| Event Name         | Payload Properties | Description                                   |
| ------------------ | ------------------ | --------------------------------------------- |
| `fullscreen/enter` |                    | Fired when the player enters fullscreen mode. |
| `fullscreen/leave` |                    | Fired when the player exits fullscreen mode.  |