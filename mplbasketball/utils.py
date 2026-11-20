from typing import Literal

import numpy as np

from mplbasketball.court_params import _get_court_params_in_desired_units

_ORIENTATIONS = ["h", "hl", "hr", "v", "vu", "vd"]
_ORIGINS = ["center", "top-left", "bottom-left", "top-right", "bottom-right"]
_COURT_TYPES = ["nba", "wnba", "ncaa", "fiba"]
_UNITS = ["ft", "m"]


def _center_court_coordinates(
    court_dims: tuple[float, float], origin: str
) -> tuple[float, float]:
    """
    Return the coordinates of center court in the requested origin convention.

    The convention matches ``Court.origin`` (see ``court.py``) and the README:
    the data is assumed to run left-right, and the quoted offsets simply scale
    with the court units (ft or m).
    """
    half_x, half_y = court_dims[0] / 2.0, court_dims[1] / 2.0
    origins = {
        "center": (0.0, 0.0),
        "top-left": (half_x, -half_y),
        "bottom-left": (half_x, half_y),
        "top-right": (-half_x, -half_y),
        "bottom-right": (-half_x, half_y),
    }
    return origins[origin]


def transform(
    x: np.ndarray,
    y: np.ndarray,
    fr: Literal["h", "hl", "hr", "v", "vu", "vd"],
    to: Literal["h", "hl", "hr", "v", "vu", "vd"],
    origin: Literal["center", "top-left", "bottom-left", "top-right", "bottom-right"],
    court_type: Literal["nba", "wnba", "ncaa", "fiba"] = "nba",
    units: Literal["ft", "m"] = "ft",
) -> tuple[np.ndarray, np.ndarray]:
    """
    Transform a set of x, y values between the six plotting orientations.

    The function is consistent with the ``Court`` class on all three axes that
    can silently misalign a plot:

    1. **Origin** - the center-court position is derived from the same five
       ``origin`` conventions used by ``Court``.
    2. **Units** - the court dimensions are fetched in ``units`` (``"ft"`` or
       ``"m"``), so the half-court symmetry axis always aligns with a court
       built in the same units, instead of being hard-coded in feet.
    3. **Orientation** - every conversion is expressed as
       (i) normalization of the source frame to its full-court canonical
       orientation (``"h"`` or ``"v"``), (ii) the h<->v 90 degree rotation if
       needed, (iii) normalization of the canonical frame to the target half.

    Half-court normalization maps every point onto the requested half through a
    180 degree rotation about center court (the operation preserves the
    right-handed coordinate system). Points that already lie in the target half
    are left untouched, and ``fr == to`` always returns the inputs unchanged.

    Parameters
    ----------
    x, y:
        Coordinates of the data points in the ``fr`` orientation.
    fr, to:
        Current and desired orientations, one of
        ``'h', 'hl', 'hr', 'v', 'vu', 'vd'``.
    origin:
        Origin convention of the data, one of
        ``'center', 'top-left', 'bottom-left', 'top-right', 'bottom-right'``.
    court_type:
        Court type, one of ``'nba', 'wnba', 'ncaa', 'fiba'``.
    units:
        Units of the input coordinates, one of ``'ft'`` (default) or ``'m'``.
        Must match the ``units`` used to build the corresponding ``Court``.

    Returns
    -------
    x, y:
        Transformed coordinates in the ``to`` orientation, returned in the
        same units as the inputs.
    """
    # Validate inputs
    if fr not in _ORIENTATIONS:
        raise ValueError(f"Invalid value for 'fr': {fr}")
    if to not in _ORIENTATIONS:
        raise ValueError(f"Invalid value for 'to': {to}")
    if origin not in _ORIGINS:
        raise ValueError(f"Invalid value for 'origin': {origin}")
    if court_type not in _COURT_TYPES:
        raise ValueError(f"Invalid value for 'court_type': {court_type}")
    if units not in _UNITS:
        raise ValueError(f"Invalid value for 'units': {units}")

    # Identity is exact, regardless of origin/units.
    if fr == to:
        return x, y

    x = np.asarray(x, dtype=float).copy()
    y = np.asarray(y, dtype=float).copy()

    # Court dimensions in the caller's units: the symmetry axis must align with
    # the court the points are plotted on (ft- or meter-based).
    court_params = _get_court_params_in_desired_units(court_type, units)
    court_dims = court_params["court_dims"]
    center_x, center_y = _center_court_coordinates(court_dims, origin)

    def normalize_horizontal(x_arr, y_arr, target):
        """Map points onto the requested horizontal half ('hl'/'hr')."""
        if target == "hl":
            mask = x_arr > center_x  # points in the right half get rotated
        else:  # 'hr'
            mask = x_arr < center_x  # points in the left half get rotated
        if np.any(mask):
            x_arr[mask] = 2.0 * center_x - x_arr[mask]
            y_arr[mask] = 2.0 * center_y - y_arr[mask]
        return x_arr, y_arr

    def normalize_vertical(x_arr, y_arr, target):
        """Map points onto the requested vertical half ('vu'/'vd')."""
        if target == "vu":
            mask = y_arr < center_x  # points in the down half get rotated
        else:  # 'vd'
            mask = y_arr > center_x  # points in the up half get rotated
        if np.any(mask):
            # The vertical frame is the pure 90 deg rotation (x, y) -> (-y, x)
            # of the horizontal frame, so center court (center_x, center_y)
            # sits at (-center_y, center_x) here. A 180 deg rotation about that
            # point reflects x about -center_y and y about center_x.
            x_arr[mask] = -2.0 * center_y - x_arr[mask]
            y_arr[mask] = 2.0 * center_x - y_arr[mask]
        return x_arr, y_arr

    # Step 1: normalize the source frame to its full-court canonical frame.
    if fr in ("hl", "hr"):
        x, y = normalize_horizontal(x, y, fr)
    elif fr in ("vu", "vd"):
        x, y = normalize_vertical(x, y, fr)

    # Step 2: rotate between the canonical horizontal and vertical frames if
    # the source and target live on different axes. The axes share the same
    # origin, so this is a pure 90 degree rotation about the coordinate origin
    # (NOT about center court - the origin convention merely shifts where
    # center court ends up, and the drawn vertical court follows the same
    # rotation).
    fr_axis = fr[0]
    to_axis = to[0]
    if fr_axis == "h" and to_axis == "v":
        # 90 degree counter-clockwise: (x, y) -> (-y, x)
        x, y = -y, x
    elif fr_axis == "v" and to_axis == "h":
        # 90 degree clockwise: (x, y) -> (y, -x)
        x, y = y, -x

    # Step 3: normalize the canonical frame to the requested target half.
    if to in ("hl", "hr"):
        x, y = normalize_horizontal(x, y, to)
    elif to in ("vu", "vd"):
        x, y = normalize_vertical(x, y, to)

    return x, y
